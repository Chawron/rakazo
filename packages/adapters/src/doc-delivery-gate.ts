/**
 * Runtime gate for document delivery.
 *
 * A bot delivers a PDF by attaching a workspace file to the chat. Writing the
 * file was never the risk; delivering it unchecked was — documents reached the
 * user with no standard applied because nothing at runtime asked for evidence.
 * This gate is that evidence check: a PDF may be attached only when the same
 * run already holds a completed doc_check result whose `passed` is true and
 * whose `sha256` equals the sha256 of the exact bytes being attached. Editing
 * the file after the check changes the hash and the delivery is refused, so
 * the checked file is the delivered file.
 *
 * The check is deliberately evidence-shaped, not tool-shaped: any completed
 * effect in the run whose result contains a passing doc_check verdict for the
 * hash counts, whatever envelope the MCP result arrived in.
 *
 * Disable with RAKAZO_DOC_DELIVERY_GATE=off (also false / 0).
 */

export function docDeliveryGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RAKAZO_DOC_DELIVERY_GATE?.trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
}

const MAX_DEPTH = 8;

/**
 * True when a tool result contains a doc_check verdict of passed=true for
 * exactly this sha256, at any nesting level (structured content, or a JSON
 * text block inside an MCP content envelope).
 */
export function effectResultProvesDocCheck(result: unknown, sha256: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return effectResultProvesDocCheck(JSON.parse(trimmed), sha256, depth + 1);
    } catch {
      return false;
    }
  }
  if (result === null || typeof result !== "object") return false;
  if (Array.isArray(result))
    return result.some((item) => effectResultProvesDocCheck(item, sha256, depth + 1));
  const record = result as Record<string, unknown>;
  if (record.passed === true && record.sha256 === sha256) return true;
  return Object.values(record).some((value) => effectResultProvesDocCheck(value, sha256, depth + 1));
}

/** The slice of the effect store the gate reads. */
export interface DocCheckEffectStore {
  externalEffect: {
    findMany(args: {
      where: { runId: string; status: "completed" };
      select: { result: true };
    }): Promise<Array<{ result: unknown }>>;
  };
}

/** True when this run already holds a passing doc_check for the file hash. */
export async function runHasPassingDocCheck(
  store: DocCheckEffectStore,
  runId: string,
  sha256: string,
): Promise<boolean> {
  const effects = await store.externalEffect.findMany({
    where: { runId, status: "completed" },
    select: { result: true },
  });
  return effects.some((effect) => effectResultProvesDocCheck(effect.result, sha256));
}
