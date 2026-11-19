let panel = null;
let trigger = null;

export function closePopover(restoreFocus = false) {
  if (!panel) return;
  const previous = trigger;
  panel.remove();
  panel = trigger = null;
  previous.setAttribute("aria-expanded", "false");
  if (restoreFocus && previous.isConnected) previous.focus();
}

function position() {
  if (!panel) return;
  if (!trigger.isConnected || !trigger.getClientRects().length) {
    closePopover();
    return;
  }
  const bounds = trigger.getBoundingClientRect();
  const edge = 10;
  const gap = 8;
  const below = Math.max(0, innerHeight - edge - bounds.bottom - gap);
  const above = Math.max(0, bounds.top - gap - edge);
  panel.style.maxHeight = "";
  const natural = panel.offsetHeight;
  const opensAbove = below < natural && above > below;
  panel.style.maxHeight = Math.min(natural, opensAbove ? above : below) + "px";
  const left = trigger.closest(".sidebar") ? bounds.left : bounds.right - panel.offsetWidth;
  panel.style.left = Math.max(edge, Math.min(innerWidth - edge - panel.offsetWidth, left)) + "px";
  panel.style.top = (opensAbove ? bounds.top - gap - panel.offsetHeight : bounds.bottom + gap) + "px";
}

export function openPopover(node, anchor) {
  const toggle = trigger === anchor;
  closePopover();
  if (toggle) return false;
  panel = node;
  trigger = anchor;
  node.classList.add("popover");
  document.querySelector("#popover-layer").append(node);
  anchor.setAttribute("aria-expanded", "true");
  position();
  const focus = node.querySelector("input") || node.querySelector(".active") || node.querySelector("button");
  focus?.focus({ preventScroll: true });
  node.addEventListener("keydown", event => {
    const options = [...node.querySelectorAll(".popover-item:not(:disabled)")];
    const index = options.indexOf(document.activeElement);
    if (!options.length) return;
    if (event.key === "Enter" && event.target.matches("input")) {
      event.preventDefault();
      options[0].click();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) || index >= 0 && ["Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length - 1 : index - 1);
      options[next].focus();
    }
  });
  return true;
}

export function refreshPopover(node) {
  if (panel === node) position();
}

export function bindPopovers() {
  window.addEventListener("resize", position);
  document.addEventListener("scroll", event => {
    if (panel && !panel.contains(event.target)) position();
  }, true);
  document.addEventListener("pointerdown", event => {
    if (panel && !panel.contains(event.target) && !trigger.contains(event.target)) closePopover();
  });
  document.addEventListener("focusin", event => {
    if (panel && !panel.contains(event.target) && !trigger.contains(event.target)) closePopover();
  });
  document.addEventListener("keydown", event => {
    if (panel && event.key === "Escape") {
      event.preventDefault();
      closePopover(true);
    }
  });
}
