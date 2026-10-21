/**
 * SVG drawn from generated markup, parsed as XML rather than assigned through innerHTML.
 * Everything here is built from numbers and constants (never a grave's title or URL),
 * but parsing keeps it that way by construction and keeps the add-on linter quiet.
 */
const NS = 'http://www.w3.org/2000/svg';
const parser = new DOMParser();

function parse(markup: string): Element {
  const doc = parser.parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName === 'parsererror' || root.querySelector('parsererror')) throw new Error('bad SVG markup');
  return root;
}

/** Replace an SVG element's children with the given inner markup. */
export function setSvg(target: Element, inner: string): void {
  const root = parse(`<svg xmlns="${NS}">${inner}</svg>`);
  target.replaceChildren(...[...root.childNodes].map((n) => document.importNode(n, true)));
}

/** A standalone <svg> element from its full markup. */
export function svgNode(markup: string): SVGSVGElement {
  const withNs = markup.includes('xmlns=') ? markup : markup.replace('<svg', `<svg xmlns="${NS}"`);
  return document.importNode(parse(withNs), true) as unknown as SVGSVGElement;
}
