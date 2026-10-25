type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  text?: string | number;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  min?: string;
  max?: string;
  step?: string;
  rows?: string;
  maxLength?: number;
  autocomplete?: string;
  inputMode?: string;
  hidden?: boolean;
  role?: string;
  ariaLabel?: string;
  ariaLive?: string;
  ariaPressed?: boolean;
  title?: string;
  onClick?: (event: MouseEvent) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
  onSubmit?: (event: SubmitEvent) => void;
}

export type { Child };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = String(props.text);
  if (props.role) node.setAttribute("role", props.role);
  if (props.ariaLabel) node.setAttribute("aria-label", props.ariaLabel);
  if (props.ariaLive) node.setAttribute("aria-live", props.ariaLive);
  if (props.ariaPressed !== undefined) node.setAttribute("aria-pressed", String(props.ariaPressed));
  if (props.title) node.title = props.title;
  if (props.hidden) node.hidden = true;

  const input = node as unknown as HTMLInputElement & HTMLAnchorElement & HTMLTextAreaElement;
  if (props.type) input.type = props.type;
  if (props.value !== undefined) input.value = props.value;
  if (props.placeholder) input.placeholder = props.placeholder;
  if (props.disabled) input.disabled = true;
  if (props.checked) input.checked = true;
  if (props.min) input.min = props.min;
  if (props.max) input.max = props.max;
  if (props.step) input.step = props.step;
  if (props.rows) input.rows = Number(props.rows);
  if (props.maxLength) input.maxLength = props.maxLength;
  if (props.autocomplete) node.setAttribute("autocomplete", props.autocomplete);
  if (props.inputMode) node.setAttribute("inputmode", props.inputMode);
  if (props.href) input.href = props.href;

  if (props.onClick) node.addEventListener("click", props.onClick as EventListener);
  if (props.onInput) node.addEventListener("input", props.onInput);
  if (props.onChange) node.addEventListener("change", props.onChange);
  if (props.onSubmit) node.addEventListener("submit", props.onSubmit as EventListener);

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

export function icon(name: keyof typeof ICONS, className = "icon"): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.appendChild(path);
  return svg;
}

export const ICONS = {
  plan: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z",
  calendar: "M4 7h16v13H4zM4 11h16M8 3v4M16 3v4",
  grid: "M4 7h16v13H4zM4 11h16M8 3v4M16 3v4M9 15h.01M12 15h.01M15 15h.01M9 18h.01M12 18h.01",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.5L5 11a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 1.7 1l.4 2.5h5l.4-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5c.1-.3.1-.7.1-1z",
  door: "M14 3v18M5 3h9v18H5zM11 12h.01",
  plus: "M12 5v14M5 12h14",
  chevron: "m9 6 6 6-6 6",
  back: "m15 6-6 6 6 6",
  close: "M6 6l12 12M18 6 6 18",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  copy: "M9 9h11v11H9zM5 15V4h11",
  check: "m5 13 4 4L19 7",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  people: "M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 19v-2a4 4 0 0 0-3-3.9M16 1.1a4 4 0 0 1 0 7.8",
  key: "M15 7a4 4 0 1 1-3.5 5.9L4 20.4 3 19.4l1.5-1.5-1-1 1.5-1.5-1-1 4.6-4.6A4 4 0 0 1 15 7z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 19h16",
  arrow: "M4 12h14m0 0-5-5m5 5-5 5",
  warn: "M12 3 2 20h20L12 3zM12 10v4M12 17h.01",
  logout: "M15 4h4v16h-4M11 8l-4 4 4 4M7 12h10",
  bell: "M18 9a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  repeat: "m17 2 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  layers: "m12 3 9 5-9 5-9-5 9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5",
  up: "m6 15 6-6 6 6",
  down: "m6 9 6 6 6-6",
} as const;
