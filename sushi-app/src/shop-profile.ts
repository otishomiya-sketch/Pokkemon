/**
 * 店舗情報（コンセプト・特徴・客単価）と価格帯。
 * 価格帯はリサーチ（ヨルノズク）とトレンドの選び方・提案の価格感をそろえるために使う。
 */

export const PRICE_BANDS = [
  { id: "value", label: "〜3,000円", examples: "回転寿司・持ち帰り・テイクアウト", max: 3000 },
  { id: "casual", label: "3,000〜8,000円", examples: "町の寿司店・立ち食い寿司・寿司居酒屋", max: 8000 },
  { id: "standard", label: "8,000〜15,000円", examples: "カウンター中心の寿司店・お好みとコースの両方", max: 15000 },
  { id: "premium", label: "15,000〜30,000円", examples: "おまかせ中心の鮨店", max: 30000 },
  { id: "luxury", label: "30,000円〜", examples: "高級鮨店・予約困難店", max: Infinity },
] as const;

export type PriceBand = (typeof PRICE_BANDS)[number]["id"];
export const BAND_IDS = PRICE_BANDS.map((b) => b.id) as PriceBand[];

export function bandFor(pricePerGuest: number): PriceBand {
  return PRICE_BANDS.find((b) => pricePerGuest < b.max)!.id;
}

export function bandLabel(band: string | null | undefined): string {
  const b = PRICE_BANDS.find((x) => x.id === band);
  return b ? `${b.label}（${b.examples}）` : "価格帯を問わない";
}

/** 隣の価格帯（トレンドが足りないときの補い先） */
export function neighborBands(band: PriceBand): PriceBand[] {
  const i = BAND_IDS.indexOf(band);
  return [BAND_IDS[i - 1], BAND_IDS[i + 1]].filter(Boolean) as PriceBand[];
}

/** 画面で選べる特徴（自由記述も併用できる） */
export const FEATURE_OPTIONS = [
  "江戸前の仕事", "地魚が中心", "熟成に力を入れている", "赤酢のシャリ", "日本酒が充実", "ワインも出す",
  "つまみが多い", "おまかせのみ", "お好みが中心", "家族連れが多い", "観光客・訪日客が多い", "接待が多い",
  "カウンターのみ", "持ち帰りあり", "ランチ営業あり", "若い客層が多い",
];

export interface ShopProfile {
  concept: string;
  features: string[];
  price_per_guest: number | null;
  price_band: PriceBand | null;
}

export class ProfileError extends Error {}

export function parseProfileInput(body: unknown): ShopProfile {
  const b = (body ?? {}) as { concept?: unknown; features?: unknown; price_per_guest?: unknown };
  const concept = typeof b.concept === "string" ? b.concept.trim().slice(0, 200) : "";
  const features = Array.isArray(b.features)
    ? [...new Set(b.features.map((f) => String(f).trim().slice(0, 30)).filter(Boolean))].slice(0, 12)
    : [];
  const price = Number(b.price_per_guest);
  if (!concept) throw new ProfileError("お店のコンセプトを書いてください");
  if (!Number.isFinite(price) || price < 500 || price > 200000) throw new ProfileError("客単価は 500〜200,000 円の数字で入れてください");
  const rounded = Math.round(price / 100) * 100;
  return { concept, features, price_per_guest: rounded, price_band: bandFor(rounded) };
}
