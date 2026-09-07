export const OG_FONT = "Noto Sans SC";

const FONT_UA =
  "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";

export async function loadOgFonts(text: string): Promise<{ name: string; data: ArrayBuffer; weight: 400 | 700 }[]> {
  const unique = Array.from(new Set(`${text}0123456789.+-%·— `)).join("");
  const [regular, bold] = await Promise.all([loadWeight(unique, 400), loadWeight(unique, 700)]);
  return [
    { name: OG_FONT, data: regular, weight: 400 },
    { name: OG_FONT, data: bold, weight: 700 },
  ];
}

async function loadWeight(text: string, weight: 400 | 700): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await fetch(cssUrl, { headers: { "User-Agent": FONT_UA } }).then((res) => {
    if (!res.ok) throw new Error(`字体 CSS ${res.status}`);
    return res.text();
  });
  const match = css.match(/src:\s*url\(([^)]+)\)/);
  if (!match) throw new Error("字体 CSS 没有 src");
  const res = await fetch(match[1].replace(/['"]/g, ""));
  if (!res.ok) throw new Error(`字体文件 ${res.status}`);
  return res.arrayBuffer();
}
