"use client";

// The form fields the wizard's steps share — and the context a blocked
// "continue" flips to show every error at once. Kept out of page.tsx so
// step 7's guest editor (guest-card.tsx) can use them too.

import { createContext, useContext, useState } from "react";
import { hostCidrMeaning, isValidIPv4, subnetDetails } from "./validation";

/**
 * Set once the visitor has tried to continue past problems: every field
 * then shows its error, touched or not. Fields normally hold an error back
 * until they've been left once, so an empty field nobody has visited looks
 * fine — which is exactly the field a blocked "continue" has to point at.
 */
export const RevealErrorsContext = createContext(false);

// A text field for anything in ip or ip/prefix notation, with a small
// toggle beside the input that expands a subnet breakdown (network,
// broadcast, usable range, host count) — collapsed by default so it
// doesn't clutter the form until someone actually wants it.
export function CidrField({
  id,
  label,
  usedFor,
  value,
  onChange,
  hint,
  error,
  placeholder,
  defaultPrefix = 24,
  required = false,
  host = false,
}: {
  id: string;
  label: string;
  // a small sub-headline under the label — what this bridge is actually
  // for (e.g. "ceph / storage traffic, backups"). NetworkAddressFields'
  // per-node address fields are often the only place a bridge shows up
  // once "identical network setup" moves its purpose checkboxes into the
  // shared section, so a field like "vmbr3 — static ip for this node"
  // otherwise gives no clue what vmbr3 even is without scrolling back up.
  usedFor?: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
  error: string | null;
  placeholder?: string;
  // if the visitor types a bare ip with no /prefix, we fill one in on
  // blur rather than leave it as a technically-different address. /32
  // would be the "literal" reading of a bare ip, but it means "no other
  // host shares this subnet" — wrong for a LAN-connected management ip
  // or bridge, so default to the real subnet size instead.
  defaultPrefix?: number;
  required?: boolean;
  // a static ip rather than a network: spells out what the prefix means,
  // and flags a /32 (see hostCidrMeaning)
  host?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  // an empty field's placeholder is just an example, not a value it
  // already has — flagging it "required" in red before the visitor has
  // ever touched it reads as "this is already wrong," when really
  // nothing's been entered yet. hold off on error styling until they've
  // actually left the field once.
  const [touched, setTouched] = useState(false);
  const info = subnetDetails(value);
  const reveal = useContext(RevealErrorsContext);
  const showError = (touched || reveal) && error;
  const meaning = host && !showError ? hostCidrMeaning(value) : null;

  function handleBlur() {
    setTouched(true);
    if (isValidIPv4(value)) onChange(`${value}/${defaultPrefix}`);
  }

  return (
    <div className={`pc-field ${showError ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
        {required && <span className="pc-field__required"> *</span>}
      </label>
      {usedFor && <p className="meta pc-field__usedfor">used for: {usedFor}</p>}
      <div className="pc-field__control">
        <span className="code pc-field__bracket">#</span>
        <input
          id={id}
          className="pc-field__input code"
          type="text"
          placeholder={placeholder ? `e.g. ${placeholder}` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
        />
        <button
          type="button"
          className="pc-cmdline__copy"
          disabled={!info}
          onClick={() => setShowDetails((s) => !s)}
          title={info ? "show subnet details" : "enter a valid ip/prefix to see subnet details"}
        >
          i
        </button>
      </div>
      <span className="body-sm pc-field__hint">{showError ? error : hint}</span>
      {meaning && (
        <span className={`body-sm pc-field__meaning${meaning.warn ? " pc-field__meaning--warn" : ""}`}>
          {meaning.warn && "⚠ "}
          {meaning.text}
        </span>
      )}
      {showDetails && info && (
        <div className="pc-table-wrap">
          <table className="pc-table">
            <tbody>
              <tr>
                <td className="body-sm">network</td>
                <td className="body-sm pc-table__num">{info.network}</td>
              </tr>
              <tr>
                <td className="body-sm">netmask</td>
                <td className="body-sm pc-table__num">
                  {info.netmask} (/{info.prefix})
                </td>
              </tr>
              <tr>
                <td className="body-sm">usable range</td>
                <td className="body-sm pc-table__num">
                  {info.firstHost} – {info.lastHost}
                </td>
              </tr>
              <tr>
                <td className="body-sm">broadcast</td>
                <td className="body-sm pc-table__num">{info.broadcast}</td>
              </tr>
              <tr>
                <td className="body-sm">usable hosts</td>
                <td className="body-sm pc-table__num">{info.usableHosts}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * A free-text field with its own validator, for step 5's addresses, paths
 * and times. Like CidrField it holds its error back until the field has
 * been left once — or until a blocked "preview" reveals every error.
 */
export function CheckedTextField({
  id,
  label,
  hint,
  value,
  placeholder,
  validate,
  onChange,
  optional = false,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  validate: (value: string) => string | null;
  onChange: (value: string) => void;
  // no required star — for a field whose blank is a real answer
  optional?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const reveal = useContext(RevealErrorsContext);
  const error = validate(value);
  const showError = (touched || reveal) && error;
  return (
    <div className={`pc-field ${showError ? "pc-field--error" : ""}`}>
      <label className="label pc-field__label" htmlFor={id}>
        {label}
        {!optional && <span className="pc-field__required"> *</span>}
      </label>
      <div className="pc-field__control">
        <span className="code pc-field__bracket">$</span>
        <input
          id={id}
          className="pc-field__input code"
          type="text"
          value={value}
          placeholder={placeholder ? `e.g. ${placeholder}` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
      <span className="body-sm pc-field__hint">{showError ? error : hint}</span>
    </div>
  );
}

/** a labelled select over a fixed set of valid options */
export function Select<T extends string>({
  id,
  label,
  hint,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="pc-field">
      <label className="label pc-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pc-field__control">
        <select id={id} className="pc-field__input code" value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {hint && <span className="body-sm pc-field__hint">{hint}</span>}
    </div>
  );
}

export function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="pc-checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="pc-checkbox__box" />
      <span>
        <span className="code pc-checkbox__label">{label}</span>
        {hint && <span className="body-sm pc-checkbox__hint">{hint}</span>}
      </span>
    </label>
  );
}
