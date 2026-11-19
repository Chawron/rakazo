import { createHash } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  isBackgroundRunTrigger,
  messageBlockForArtifact,
} from "@rakazo/core";
import type { Artifact, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { desktopGuardApplies, desktopProtectionGuardMessage } from "./desktop-command-guard.js";
import { protectedActivateScriptWriteRefusal } from "./desktop-guard-words.js";
import {
  docDeliveryGateEnabled,
  isPdfContent,
  runHasPassingDocCheck,
} from "./doc-delivery-gate.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import { mediaDelivery, scheduleMediaPoll } from "./media-video-poll.js";
import type { RunContext } from "./run-context.js";
import { persistMessageInTransaction, runLeaseFor } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { recordComputerAction } from "./run-tools-computer.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { textContentArg } from "./tool-text.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { listFilesFromTool, readFileFromTool, renderPlotFromTool } from "./workspace-file-tools.js";

export type AttachmentBlock = Extract<MessageBlock, { kind: "image" | "file" }>;

function runWorkspace(ctx: RunContext, call: ToolCall): RunWorkspace {
  return {
    botId: ctx.bot.id,
    computerMode: ctx.computer.mode,
    computer: () => ctx.computer.get("tool", call.name),
    markDirty: () => ctx.computer.checkpoint.markDirty(),
    context: ctx.context,
    runSecrets: ctx.secrets,
  };
}

/** Generate an image or video, or with recoverOnly, only resume a job an earlier attempt started. */
export async function callMediaTool(ctx: RunContext, call: ToolCall, recoverOnly = false) {
  const { deps, run, thread, context } = ctx;
  const { name, args, executionId, applied } = call;
  const mediaGeneration = ctx.providers.mediaGeneration;
  if (
    (name !== "generate_image" && name !== "generate_video") ||
    isBackgroundRunTrigger(run.trigger) ||
    !mediaGeneration ||
    !deps.artifacts
  )
    return { error: "Media generation is unavailable." };
  const result = await generateMediaFromTool({
    name,
    args,
    executionId: applied?.effect.id ?? executionId,
    recoverOnly,
    provider: mediaGeneration,
    prisma: deps.prisma,
    context,
    run,
    threadGeneration: thread.historyCompactionGeneration,
    ...mediaDelivery({ ...deps, artifacts: deps.artifacts }, run, {
      providerId: mediaGeneration.id,
      groupId: thread.groupId ?? undefined,
      operationId: executionId,
    }),
  });
  // The run may end before the video does, so a background poll posts it when it is ready.
  if (
    result &&
    "jobId" in result &&
    result.jobId &&
    "status" in result &&
    (result.status === "queued" || result.status === "running")
  )
    await scheduleMediaPoll(deps.jobs, result.jobId);
  return result;
}

async function generateMedia(ctx: RunContext, call: ToolCall) {
  return call.finish(await callMediaTool(ctx, call));
}

/** Workspace files, attachments, plots and generated media. */
export const fileTools: ToolHandlers = {
  async list_files(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    return listFilesFromTool(deps.sandbox, workspace, args);
  },
  async read_file(ctx, call) {
    const { deps } = ctx;
    const { args } = call;
    const workspace = runWorkspace(ctx, call);
    return readFileFromTool(deps.sandbox, workspace, args);
  },
  async write_file(ctx, call) {
    const { deps, bot, context } = ctx;
    const { name, args } = call;
    const filePath = String(args.path ?? "notes/result.txt");
    if (desktopGuardApplies(ctx.computer)) {
      const activateRefusal = protectedActivateScriptWriteRefusal(filePath);
      if (activateRefusal) {
        return call.finish({ error: desktopProtectionGuardMessage(activateRefusal) });
      }
    }
    const content = new TextEncoder().encode(textContentArg(args.content, ""));
    ctx.computer.checkpoint.markDirty();
    try {
      await deps.sandbox.writeFile(
        await ctx.computer.get("tool", name),
        { path: resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath), content },
        context,
      );
    } catch (error) {
      await recordComputerAction(ctx, call, "write_file", filePath, {
        error: error instanceof Error ? error.message : "could not write file",
      });
      throw error;
    }
    await recordComputerAction(ctx, call, "write_file", filePath, { bytes: content.byteLength });
    return call.finish({ ok: true, path: filePath });
  },
  generate_image: generateMedia,
  generate_video: generateMedia,
  async render_plot(ctx, call) {
    const { deps, run } = ctx;
    const { args, executionId } = call;
    const workspace = runWorkspace(ctx, call);
    return renderPlotFromTool(deps, run, args, executionId, workspace, call.finish);
  },
  async attach_file(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const filePath = String(call.args.path ?? "");
    const fail = async (error: string) => {
      await recordComputerAction(ctx, call, "attach_file", filePath, { error });
      return call.finish({ error, path: filePath });
    };
    const read = await readWorkspaceFile(ctx, call, filePath);
    if ("error" in read) return fail(read.error);
    if (
      docDeliveryGateEnabled() &&
      (filePath.toLowerCase().endsWith(".pdf") || isPdfContent(read.bytes))
    ) {
      const sha256 = createHash("sha256").update(read.bytes).digest("hex");
      if (!(await runHasPassingDocCheck(deps.prisma, run.id, sha256)))
        return fail(
          "Document delivery gate: this file is a PDF (by name or by content) and has not passed doc_check in this run, so it was not delivered. " +
            "For a document: doc_render it, run doc_check until passed is true, download the checked file into this workspace with curl from the download_path doc_render returned, verify its sha256 matches, and attach it unchanged. " +
            "For a drawing or another PDF made here: upload it to the checker with curl --data-binary, run doc_check with profile \"sheet\", and attach it unchanged once it passes. " +
            "The gate matches the delivered file's sha256 against the passing check; renaming the file does not change that. " +
            "If the doc-checker tools are unavailable, tell the user instead of delivering an unchecked PDF.",
        );
    }
    try {
      // Background runs post no message (publishMessage drops attachment blocks).
      const background = isBackgroundRunTrigger(run.trigger);
      const lease = runLeaseFor(deps, run.id);
      let committed: Awaited<ReturnType<typeof persistMessageInTransaction>> | undefined;
      const saved = await saveWorkspaceFile(
        ctx,
        call,
        filePath,
        read.bytes,
        { botId: bot.id, groupId: thread.groupId ?? undefined },
        {
          name: typeof call.args.name === "string" ? call.args.name : undefined,
          description:
            typeof call.args.description === "string" ? call.args.description : undefined,
        },
        // The message commits with the artifact row, so a post that fails leaves no artifact
        // the user was never shown.
        background
          ? undefined
          : async (tx, artifact) => {
              committed = await persistMessageInTransaction(
                tx,
                run,
                "bot",
                [messageBlockForArtifact(artifact)],
                run.trigger === "bot_message" ? false : undefined,
                undefined,
                false,
                lease,
              );
            },
      );
      if (committed)
        await deps.events
          .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
          .catch((error) => getLogger().error("thread message realtime notification", error));
      await recordComputerAction(ctx, call, "attach_file", filePath);
      return call.finish({ ok: true, artifactId: saved.artifactId, path: filePath });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "could not attach file");
    }
  },
};

/** Read a file from this bot's computer that can become an attachment, without saving it. */
export async function readWorkspaceFile(
  ctx: RunContext,
  call: ToolCall,
  filePath: string,
): Promise<{ error: string } | { bytes: Uint8Array }> {
  const { deps, bot, context } = ctx;
  if (!deps.artifacts) return { error: "artifact storage unavailable" };
  let bytes: Uint8Array;
  try {
    bytes = await deps.sandbox.readFile(
      await ctx.computer.get("tool", call.name),
      resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath),
      context,
      { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
    );
  } catch {
    return { error: "file not found or unreadable" };
  }
  if (!inferAttachmentMimeType(filePath)) return { error: "unsupported attachment type" };
  return { bytes };
}

/**
 * Save a file read from this bot's computer as an attachment of the chat that will show it:
 * a bot's own chat, or a group's.
 */
export async function saveWorkspaceFile(
  ctx: RunContext,
  call: ToolCall,
  filePath: string,
  bytes: Uint8Array,
  owner: { botId: string; groupId?: string },
  meta: { name?: string; description?: string } = {},
  onAttached?: (tx: Prisma.TransactionClient, artifact: Artifact) => Promise<void>,
): Promise<{ artifactId: string; block: AttachmentBlock }> {
  const { deps, run } = ctx;
  if (!deps.artifacts) throw new Error("artifact storage unavailable");
  return attachWorkspaceFileToThread(
    { prisma: deps.prisma, artifacts: deps.artifacts, maxUploadSizeBytes: deps.maxUploadSizeBytes },
    {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: owner.botId,
      groupId: owner.groupId,
      runId: run.id,
      filePath,
      bytes,
      operationId: call.executionId,
      name: meta.name,
      description: meta.description,
      onAttached,
    },
  );
}
