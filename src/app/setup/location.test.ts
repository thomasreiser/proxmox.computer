import { describe, expect, it } from "vitest";
import {
  COUNTRY_OPTIONS,
  KEYBOARD_OPTIONS,
  countryFor,
  countryName,
  defaultLocation,
  detectLocation,
  keyboardFor,
  timezoneOptions,
  validateCountry,
  validateKeyboard,
  validateTimezone,
} from "./location";

describe("keyboardFor", () => {
  it.each([
    ["de-AT", "de"],
    ["de-CH", "de-ch"],
    ["en-GB", "en-gb"],
    ["en-US", "en-us"],
    ["fr-CA", "fr-ca"],
    ["pt_BR", "pt-br"],
    ["sv-SE", "se"],
    ["da", "dk"],
    ["ja-JP", "jp"],
    ["nb-NO", "no"],
  ])("maps %s to %s", (locale, layout) => {
    expect(keyboardFor(locale)).toBe(layout);
  });

  // only layouts the installer accepts, or it rejects the file
  it("falls back to en-us for anything the installer doesn't know", () => {
    expect(keyboardFor("zh-CN")).toBe("en-us");
    expect(keyboardFor("")).toBe("en-us");
  });
});

describe("countryFor", () => {
  it("takes the locale's region", () => {
    expect(countryFor("de-AT")).toBe("at");
    expect(countryFor("en_GB")).toBe("gb");
  });

  it("falls back to us without a known region", () => {
    expect(countryFor("de")).toBe("us");
    expect(countryFor("es-419")).toBe("us");
    expect(countryFor("en-XX")).toBe("us");
  });
});

describe("the options", () => {
  it("offers every layout the installer takes, and only those", () => {
    expect(KEYBOARD_OPTIONS.map((k) => k.value).sort()).toEqual(
      ["de", "de-ch", "dk", "en-gb", "en-us", "es", "fi", "fr", "fr-be", "fr-ca", "fr-ch", "hu", "is", "it", "jp",
        "lt", "mk", "nl", "no", "pl", "pt", "pt-br", "se", "si", "tr"].sort(),
    );
  });

  it("lists every iso country, lowercase, by name", () => {
    expect(COUNTRY_OPTIONS).toHaveLength(249);
    expect(COUNTRY_OPTIONS.every((c) => /^[a-z]{2}$/.test(c.code))).toBe(true);
    const names = COUNTRY_OPTIONS.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    // sorted as people look for it, not by code point
    expect(names.indexOf("Åland Islands")).toBeLessThan(names.indexOf("Albania"));
    expect(countryName("at")).toBe("Austria");
  });

  // Intl leaves UTC itself out of its list
  it("offers UTC first, then every zone the browser knows", () => {
    const zones = timezoneOptions();
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("Europe/Vienna");
    expect(zones.filter((z) => z === "UTC")).toHaveLength(1);
  });
});

describe("defaults", () => {
  it("starts from the us and utc", () => {
    expect(defaultLocation()).toEqual({ country: "us", keyboard: "en-us", timezone: "UTC" });
  });

  it("guesses a new setup's location from the browser", () => {
    expect(detectLocation("de-AT", "Europe/Vienna")).toEqual({ country: "at", keyboard: "de", timezone: "Europe/Vienna" });
  });

  it("falls back to utc for a timezone it doesn't know", () => {
    expect(detectLocation("en-US", "Mars/Olympus_Mons").timezone).toBe("UTC");
    expect(detectLocation("en-US", "").timezone).toBe("UTC");
  });
});

describe("validation", () => {
  it("takes only the installer's layouts, iso countries and known zones", () => {
    expect(validateKeyboard("de")).toBeNull();
    expect(validateKeyboard("dvorak")).not.toBeNull();
    expect(validateCountry("at")).toBeNull();
    expect(validateCountry("AT")).not.toBeNull();
    expect(validateCountry("xx")).not.toBeNull();
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("Europe/Vienna")).toBeNull();
    expect(validateTimezone("Mars/Olympus_Mons")).not.toBeNull();
  });
});
