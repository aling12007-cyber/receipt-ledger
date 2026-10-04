// Receipt Ledger — tax deadlines for a sole proprietor. A deadline on a Saturday or Sunday moves to the next Monday
// (国税通則法10条2項); national holidays are not modelled, so a date can be a day early around a holiday.
// Exposes window.TaxCalendar (and module.exports for tests).
(function (root) {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  /** @param {number} y @param {number} m 1-12 @param {number} d */
  function due(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    const wd = t.getUTCDay();
    if (wd === 6) t.setUTCDate(t.getUTCDate() + 2);
    if (wd === 0) t.setUTCDate(t.getUTCDate() + 1);
    return ymd(t);
  }

  /**
   * Deadlines that belong to tax year `year` (some fall in the year after).
   * @param {number} year
   * @param {{ ctax?: string, prepay?: boolean, assets?: boolean, businessTax?: boolean }} o
   * @returns {Array<{ date: string, key: string, kind: "deadline"|"info", year: number, link?: string }>}
   */
  function forYear(year, o = {}) {
    const n = year + 1, out = [];
    const add = (date, key, kind = "deadline", link) => out.push({ date, key, kind, year, link });
    if (o.prepay) { add(due(year, 7, 31), "dlPrepay1"); add(due(year, 11, 30), "dlPrepay2"); }
    if (o.ctax === "general") add(due(year, 12, 31), "dlSimpleElect", "info");
    add(`${year}-12-31`, "dlClose", "info");
    if (o.assets) add(due(n, 1, 31), "dlDepreciableAssets");
    add(due(n, 2, 16), "dlReturnOpen", "info", "https://www.keisan.nta.go.jp/");
    add(due(n, 3, 15), "dlIncomeTax", "deadline", "https://www.keisan.nta.go.jp/");
    if (o.ctax && o.ctax !== "exempt") add(due(n, 3, 31), "dlConsumptionTax", "deadline", "https://www.keisan.nta.go.jp/");
    add(due(n, 6, 30), "dlResident1");
    if (o.businessTax) { add(due(n, 8, 31), "dlBusinessTax1"); add(due(n, 11, 30), "dlBusinessTax2"); }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * The next deadlines from `today`, across the current and previous tax year.
   * @param {string} today YYYY-MM-DD @param {{ ctax?: string, prepay?: boolean, assets?: boolean, businessTax?: boolean }} o @param {number} [limit]
   */
  function upcoming(today, o = {}, limit = 5) {
    const y = Number(today.slice(0, 4));
    return [...forYear(y - 1, o), ...forYear(y, o)].filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit)
      .map((x) => ({ ...x, days: Math.round((Date.parse(x.date) - Date.parse(today)) / 864e5) }));
  }

  /**
   * iCalendar file (.ics) with all-day events and reminders 7 days and 1 day before, for a phone or desktop calendar.
   * @param {Array<{ date: string, title: string, description?: string, url?: string, uid: string }>} events
   */
  function toICS(events, stamp) {
    const esc = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const d8 = (d) => d.replace(/-/g, "");
    const next = (d) => { const t = new Date(Date.parse(d + "T00:00:00Z") + 864e5); return t.toISOString().slice(0, 10).replace(/-/g, ""); };
    const now = (stamp || new Date().toISOString()).replace(/[-:]/g, "").replace(/\.\d+/, "");
    // lines longer than 75 octets are folded (RFC 5545), counting UTF-8 bytes so Japanese text is not cut too late
    const bytes = (ch) => { const c = ch.codePointAt(0) || 0; return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; };
    const fold = (l) => { const out = []; let cur = "", n = 0; for (const ch of l) { const b = bytes(ch); if (n + b > 74) { out.push(cur); cur = " "; n = 1; } cur += ch; n += b; } out.push(cur); return out.join("\r\n"); };
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Smart Ledger//Tax deadlines//JA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:税金の期限"];
    for (const e of events) {
      lines.push("BEGIN:VEVENT", `UID:${e.uid}@smart-ledger`, `DTSTAMP:${now}`, `DTSTART;VALUE=DATE:${d8(e.date)}`, `DTEND;VALUE=DATE:${next(e.date)}`,
        `SUMMARY:${esc(e.title)}`, ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []), ...(e.url ? [`URL:${e.url}`] : []), "TRANSP:TRANSPARENT");
      for (const tr of ["-P7D", "-P1D"]) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:${tr}`, "END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  const api = { due, forYear, upcoming, toICS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaxCalendar = api;
})(typeof window !== "undefined" ? window : globalThis);
