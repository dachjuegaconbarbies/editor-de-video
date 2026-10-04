/**
 * Miniaturas ilustradas (SVG en data URI) para los datos de ejemplo del modo demo.
 * No dependen de la red ni de archivos: se generan aquí mismo.
 */

export type ThumbScene = "persona" | "producto" | "paisaje" | "ciudad" | "taza" | "local" | "logo" | "ondas" | "voz";

const enc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const PALETTES: Record<ThumbScene, [string, string, string]> = {
  persona: ["#F6D5B3", "#E9A981", "#7A4B33"],
  producto: ["#FBE88A", "#F2C46D", "#8A5A2B"],
  paisaje: ["#BFE3F2", "#F7C59F", "#4E6E58"],
  ciudad: ["#2E3A59", "#F2A65A", "#151B2C"],
  taza: ["#E7D3C1", "#B07D62", "#4A2E22"],
  local: ["#D8CFC4", "#A5876B", "#3E3229"],
  logo: ["#FFFFFF", "#1F1F1F", "#EE6B6B"],
  ondas: ["#ECE9FD", "#8B7CF0", "#5B4BD6"],
  voz: ["#BFEFD3", "#4FB286", "#1E6B4A"],
};

/** Escena ilustrada; `vertical` = 9:16, si no 16:9. */
export function sceneThumb(scene: ThumbScene, vertical = false): string {
  const [a, b, c] = PALETTES[scene];
  const w = vertical ? 180 : 320;
  const h = vertical ? 320 : 180;
  const cx = w / 2;
  const defs = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><radialGradient id="r" cx="0.5" cy="0.35" r="0.6"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`;
  let body = "";
  switch (scene) {
    case "persona": {
      const s = vertical ? 1 : 0.8;
      body = `<rect width="${w}" height="${h}" fill="url(#r)"/><circle cx="${cx}" cy="${h * 0.4}" r="${30 * s}" fill="${c}"/><path d="M${cx - 70 * s} ${h} C ${cx - 64 * s} ${h * 0.62}, ${cx + 64 * s} ${h * 0.62}, ${cx + 70 * s} ${h} Z" fill="${c}"/><circle cx="${cx}" cy="${h * 0.4}" r="${30 * s}" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="3"/>`;
      break;
    }
    case "producto":
      body = `<rect width="${w}" height="${h}" fill="url(#r)"/><ellipse cx="${cx}" cy="${h * 0.8}" rx="${w * 0.22}" ry="8" fill="#000" opacity="0.12"/><rect x="${cx - 26}" y="${h * 0.32}" width="52" height="${h * 0.48}" rx="12" fill="${c}"/><rect x="${cx - 14}" y="${h * 0.22}" width="28" height="${h * 0.12}" rx="5" fill="${c}"/><rect x="${cx - 18}" y="${h * 0.48}" width="36" height="22" rx="4" fill="#fff" opacity="0.85"/>`;
      break;
    case "paisaje":
      body = `<circle cx="${w * 0.72}" cy="${h * 0.32}" r="${Math.min(w, h) * 0.11}" fill="#FFF3D6"/><path d="M0 ${h * 0.72} L${w * 0.28} ${h * 0.45} L${w * 0.5} ${h * 0.66} L${w * 0.7} ${h * 0.5} L${w} ${h * 0.74} L${w} ${h} L0 ${h} Z" fill="${c}"/><path d="M0 ${h * 0.82} L${w * 0.35} ${h * 0.64} L${w * 0.62} ${h * 0.8} L${w} ${h * 0.7} L${w} ${h} L0 ${h} Z" fill="${c}" opacity="0.7"/>`;
      break;
    case "ciudad": {
      let bars = "";
      const n = vertical ? 6 : 9;
      for (let i = 0; i < n; i++) {
        const bw = w / n;
        const bh = h * (0.25 + ((i * 37) % 50) / 100);
        bars += `<rect x="${i * bw + 2}" y="${h - bh}" width="${bw - 4}" height="${bh}" fill="${c}"/>`;
        for (let k = 0; k < 4; k++) bars += `<rect x="${i * bw + 7}" y="${h - bh + 10 + k * 16}" width="5" height="7" fill="${b}" opacity="0.8"/>`;
      }
      body = `<circle cx="${w * 0.25}" cy="${h * 0.28}" r="16" fill="${b}" opacity="0.9"/>${bars}`;
      break;
    }
    case "taza":
      body = `<rect width="${w}" height="${h}" fill="url(#r)"/><ellipse cx="${cx}" cy="${h * 0.72}" rx="${w * 0.24}" ry="10" fill="#000" opacity="0.1"/><path d="M${cx - 38} ${h * 0.45} h76 v34 a38 30 0 0 1 -76 0 Z" fill="${c}"/><path d="M${cx + 38} ${h * 0.5} a14 14 0 0 1 0 26" fill="none" stroke="${c}" stroke-width="7"/><path d="M${cx - 12} ${h * 0.38} q8 -10 0 -20 M${cx + 6} ${h * 0.38} q8 -10 0 -20" stroke="#fff" stroke-opacity="0.8" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      break;
    case "local":
      body = `<rect x="${w * 0.12}" y="${h * 0.3}" width="${w * 0.76}" height="${h * 0.6}" fill="${c}" opacity="0.9"/><path d="M${w * 0.08} ${h * 0.3} h${w * 0.84} l-${w * 0.06} -${h * 0.12} h-${w * 0.72} Z" fill="#EE6B6B"/><rect x="${w * 0.22}" y="${h * 0.48}" width="${w * 0.22}" height="${h * 0.42}" fill="${a}"/><rect x="${w * 0.54}" y="${h * 0.46}" width="${w * 0.24}" height="${h * 0.2}" fill="${a}" opacity="0.8"/>`;
      break;
    case "logo":
      body = `<circle cx="${cx}" cy="${h / 2}" r="${Math.min(w, h) * 0.26}" fill="${b}"/><path d="M${cx - 18} ${h / 2 + 8} q18 -40 36 0" stroke="${c}" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="${cx}" cy="${h / 2 + 14}" r="5" fill="#fff"/>`;
      break;
    case "ondas":
    case "voz": {
      let bars = "";
      const n = 24;
      for (let i = 0; i < n; i++) {
        const bh = h * (0.12 + Math.abs(Math.sin(i * 1.7)) * 0.5);
        bars += `<rect x="${(w / n) * i + 3}" y="${(h - bh) / 2}" width="${w / n - 6}" height="${bh}" rx="3" fill="${c}" opacity="0.85"/>`;
      }
      body = bars;
      break;
    }
  }
  return enc(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}<rect width="${w}" height="${h}" fill="url(#g)"/>${body}</svg>`);
}

/** Cartel de una versión: escena + subtítulo con palabra resaltada (parece un reel). */
export function posterThumb(version: number, vertical = true, font = "Inter"): string {
  const w = vertical ? 360 : 640;
  const h = vertical ? 640 : 360;
  const cx = w / 2;
  const s = vertical ? 1.6 : 1.1;
  const hue = version % 2 === 0 ? ["#2B2A3D", "#5B4BD6"] : ["#3A2A22", "#B07D62"];
  const caption = version % 2 === 0 ? ["EL CAFÉ DE OLLA", "MÁS RICO"] : ["EL CAFÉ DE OLLA", "MÁS RICO"];
  const capY = vertical ? h * 0.72 : h * 0.78;
  const fs = vertical ? 30 : 26;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${hue[1]}"/><stop offset="1" stop-color="${hue[0]}"/></linearGradient>
<radialGradient id="l" cx="0.5" cy="0.32" r="0.55"><stop offset="0" stop-color="#FBE88A" stop-opacity="0.55"/><stop offset="1" stop-color="#FBE88A" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#l)"/>
<circle cx="${cx}" cy="${h * 0.36}" r="${32 * s}" fill="#F6D5B3"/>
<path d="M${cx - 80 * s} ${h * 0.88} C ${cx - 70 * s} ${h * 0.5}, ${cx + 70 * s} ${h * 0.5}, ${cx + 80 * s} ${h * 0.88} Z" fill="#1F1F1F" opacity="0.92"/>
<rect x="${w * 0.08}" y="${h * 0.06}" width="${w * 0.84}" height="${vertical ? 4 : 3}" rx="2" fill="#fff" opacity="0.35"/>
<rect x="${w * 0.08}" y="${h * 0.06}" width="${w * 0.84 * (version % 2 === 0 ? 0.62 : 0.38)}" height="${vertical ? 4 : 3}" rx="2" fill="#fff" opacity="0.9"/>
<text x="${cx}" y="${capY}" text-anchor="middle" font-family="${font}, Georgia, serif" font-weight="800" font-size="${fs}" fill="#fff" stroke="#000" stroke-width="1.2" paint-order="stroke">${caption[0]}</text>
<text x="${cx}" y="${capY + fs * 1.2}" text-anchor="middle" font-family="${font}, Georgia, serif" font-weight="800" font-size="${fs}" fill="#FBE88A" stroke="#000" stroke-width="1.2" paint-order="stroke">${caption[1]}</text>
</svg>`;
  return enc(svg);
}
