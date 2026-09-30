import type { Meter } from "./capacity";
import { formatGb } from "./storage";

// memory in gib with a decimal where it matters, disks the way step 4 says them
function amount(gb: number, unit: "gib" | "gb"): string {
  if (unit === "gb") return formatGb(gb) === "—" ? "0 gb" : formatGb(gb);
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} gib`;
}

/**
 * One capacity meter: a stacked bar of what takes the space, then what's
 * free, with the legend carrying every value in words — color is never the
 * only way to tell the segments apart. Overcommitted, the bar grows past
 * its end and a line marks where the capacity stops.
 *
 * `compact` is step 7's live version: the bar and how much is left, no
 * legend or notes — each segment still names itself on hover, and the
 * figure's label carries the numbers.
 */
export function MeterBar({ meter, unit, compact = false }: { meter: Meter; unit: "gib" | "gb"; compact?: boolean }) {
  const used = meter.segments.reduce((s, seg) => s + seg.gb, 0);
  const scale = Math.max(meter.totalGb, used) || 1;
  const pct = (gb: number) => `${(gb / scale) * 100}%`;
  const summary = `${meter.title}: ${amount(used, unit)} of ${amount(meter.totalGb, unit)} used${meter.overGb > 0 ? `, ${amount(meter.overGb, unit)} over` : ""}`;

  return (
    <figure className={`pc-meter ${compact ? "pc-meter--compact" : ""}`} aria-label={summary}>
      <figcaption className="pc-meter__head">
        <span className="label pc-meter__title">{meter.title}</span>
        <span className={`code pc-meter__total ${(compact ? meter.room.overGb : meter.overGb) > 0 ? "pc-meter__total--over" : ""}`}>
          {(compact ? meter.room.overGb : meter.overGb) > 0 && "✗ "}
          {compact
            ? meter.room.overGb > 0
              ? `${amount(meter.room.overGb, unit)} over`
              : `${amount(meter.room.freeGb, unit)} free of ${amount(meter.room.totalGb, unit)}`
            : `${amount(used, unit)} / ${amount(meter.totalGb, unit)}${meter.overGb > 0 ? ` — ${amount(meter.overGb, unit)} over` : ""}`}
        </span>
      </figcaption>
      <div className="pc-meter__track">
        {meter.segments.map((seg) => (
          <span
            key={seg.key}
            className={`pc-meter__seg pc-meter__seg--${seg.tone}`}
            style={{ width: pct(seg.gb) }}
            title={`${seg.label}: ${amount(seg.gb, unit)}`}
          />
        ))}
        {meter.overGb > 0 && <span className="pc-meter__limit" style={{ left: pct(meter.totalGb) }} title="capacity" />}
        {meter.marker && meter.overGb === 0 && (
          <span className="pc-meter__marker" style={{ left: pct(meter.marker.at * meter.totalGb) }} title={meter.marker.label} />
        )}
      </div>
      {!compact && (
        <ul className="pc-meter__legend">
          {meter.segments.map((seg) => (
            <li key={seg.key} className="pc-meter__item">
              <span className={`pc-meter__swatch pc-meter__seg--${seg.tone}`} aria-hidden="true" />
              <span className="meta pc-meter__label">{seg.label}</span>
              <span className="code pc-meter__value">{amount(seg.gb, unit)}</span>
            </li>
          ))}
          <li className="pc-meter__item">
            <span className="pc-meter__swatch pc-meter__swatch--free" aria-hidden="true" />
            <span className="meta pc-meter__label">free</span>
            <span className="code pc-meter__value">{amount(meter.freeGb, unit)}</span>
          </li>
          {meter.marker && (
            <li className="pc-meter__item">
              <span className="pc-meter__swatch pc-meter__swatch--marker" aria-hidden="true" />
              <span className="meta pc-meter__label">{meter.marker.label}</span>
            </li>
          )}
        </ul>
      )}
      {!compact && <p className="meta pc-meter__note">{meter.note}</p>}
    </figure>
  );
}
