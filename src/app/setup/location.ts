// Step 1's logic: where the cluster lives — the three things proxmox's
// installer asks before anything else (keyboard, country, timezone). Seeded
// from the visitor's own browser for a new setup, then theirs to change.

import countries from "@/data/countries.json";

export interface LocationPlan {
  // two-letter iso 3166 code, lowercase — as the installer takes it
  country: string;
  // one of the installer's own layouts (KEYBOARD_OPTIONS)
  keyboard: string;
  // an iana tzdata name, e.g. "Europe/Vienna"
  timezone: string;
}

// the layouts proxmox's installer accepts for `keyboard`, and what they are
export const KEYBOARD_OPTIONS: { value: string; label: string }[] = [
  { value: "en-us", label: "english (us)" },
  { value: "en-gb", label: "english (uk)" },
  { value: "de", label: "german" },
  { value: "de-ch", label: "german (switzerland)" },
  { value: "fr", label: "french" },
  { value: "fr-be", label: "french (belgium)" },
  { value: "fr-ca", label: "french (canada)" },
  { value: "fr-ch", label: "french (switzerland)" },
  { value: "es", label: "spanish" },
  { value: "it", label: "italian" },
  { value: "pt", label: "portuguese" },
  { value: "pt-br", label: "portuguese (brazil)" },
  { value: "nl", label: "dutch" },
  { value: "dk", label: "danish" },
  { value: "se", label: "swedish" },
  { value: "no", label: "norwegian" },
  { value: "fi", label: "finnish" },
  { value: "is", label: "icelandic" },
  { value: "pl", label: "polish" },
  { value: "hu", label: "hungarian" },
  { value: "si", label: "slovenian" },
  { value: "lt", label: "lithuanian" },
  { value: "mk", label: "macedonian" },
  { value: "tr", label: "turkish" },
  { value: "jp", label: "japanese" },
];

const KEYBOARDS = new Set(KEYBOARD_OPTIONS.map((o) => o.value));

// by name, as people look for them — "Åland Islands" under A, not after Z
export const COUNTRY_OPTIONS: { code: string; name: string }[] = [...countries].sort((a, b) =>
  a.name.localeCompare(b.name, "en"),
);
const COUNTRIES = new Set(COUNTRY_OPTIONS.map((c) => c.code));

/**
 * Every timezone this browser knows, UTC first. Intl leaves UTC itself out
 * of its list, and it's the one a server is often set to.
 */
export function timezoneOptions(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return ["UTC", ...zones.filter((z) => z !== "UTC")];
}

// languages whose layout proxmox names after something else
const LANGUAGE_KEYBOARD: Record<string, string> = { da: "dk", sv: "se", ja: "jp", nb: "no", nn: "no", sl: "si" };

/**
 * A best guess at the installer's keyboard layout from a browser locale
 * ("de-CH" → "de-ch", "sv-SE" → "se"), falling back to en-us.
 */
export function keyboardFor(locale: string): string {
  const [language = "", region = ""] = locale.toLowerCase().split(/[-_]/);
  const regional = `${language}-${region}`;
  if (region && KEYBOARDS.has(regional)) return regional;
  const mapped = LANGUAGE_KEYBOARD[language] ?? language;
  return KEYBOARDS.has(mapped) ? mapped : "en-us";
}

/** the country from a locale's region, or "us" */
export function countryFor(locale: string): string {
  const region = (locale.split(/[-_]/)[1] ?? "").toLowerCase();
  return COUNTRIES.has(region) ? region : "us";
}

export function defaultLocation(): LocationPlan {
  return { country: "us", keyboard: "en-us", timezone: "UTC" };
}

/** a new setup's location, guessed from the browser it's being made in */
export function detectLocation(locale: string, timezone: string): LocationPlan {
  return {
    country: countryFor(locale),
    keyboard: keyboardFor(locale),
    timezone: timezone && timezoneOptions().includes(timezone) ? timezone : "UTC",
  };
}

export function validateKeyboard(value: string): string | null {
  return KEYBOARDS.has(value) ? null : "pick one of the layouts the installer knows";
}

export function validateCountry(value: string): string | null {
  return COUNTRIES.has(value) ? null : "pick a country";
}

export function validateTimezone(value: string): string | null {
  return timezoneOptions().includes(value) ? null : "pick a timezone — this browser doesn't know that one";
}

export function countryName(code: string): string {
  return COUNTRY_OPTIONS.find((c) => c.code === code)?.name ?? code;
}
