import type { OfxTransaction } from "../types/finance.js";
import { ofxDateToIso } from "../utils/dates.js";

function tagValue(block: string, tag: string): string | undefined {
  const xml = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
  if (xml) return xml.trim();

  const sgml = block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, "i"))?.[1];
  return sgml?.trim();
}

function amountToCents(value: string): number | undefined {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100);
}

export class OfxParser {
  parse(content: string): OfxTransaction[] {
    const blocks = content.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|$)/gi) || [];
    const transactions: OfxTransaction[] = [];

    for (const block of blocks) {
      const date = ofxDateToIso(tagValue(block, "DTPOSTED") || "");
      const amount = amountToCents(tagValue(block, "TRNAMT") || "");
      const description = tagValue(block, "NAME") || tagValue(block, "MEMO") || tagValue(block, "CHECKNUM");
      if (!date || amount === undefined || !description) continue;

      transactions.push({
        fit_id: tagValue(block, "FITID"),
        date,
        amount_cents: amount,
        description,
        memo: tagValue(block, "MEMO")
      });
    }

    return transactions;
  }
}
