import { useEffect, useState } from "react";

/** How long the confirmation shows before the button reads "Copy ID" again. */
const CONFIRM_MS = 1_500;

/** Copies with the clipboard API, or the older select-and-copy where that isn't available. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

/** A quiet button that copies a node's ID, for `aop steer` and the other node commands. */
export function CopyId({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), state === "copied" ? CONFIRM_MS : CONFIRM_MS * 4);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <span className="copy-id">
      <button type="button" className="btn-quiet" title={id} onClick={() => void copyText(id).then((ok) => setState(ok ? "copied" : "failed"))}>
        Copy ID
      </button>
      <span className="copy-id-status muted" role="status">
        {state === "copied" ? "Copied" : null}
        {state === "failed" ? (
          <>
            Couldn't copy: <code>{id}</code>
          </>
        ) : null}
      </span>
    </span>
  );
}
