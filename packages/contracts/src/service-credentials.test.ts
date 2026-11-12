import { describe, expect, it } from "vitest";
import {
  parseTelegramOwnerUserIds,
  ServiceCredentialsUpdateSchema,
} from "./service-credentials.js";

describe("parseTelegramOwnerUserIds", () => {
  it("parses a comma-separated list, trimming spaces", () => {
    expect(parseTelegramOwnerUserIds("123456789, 987654321")).toEqual(["123456789", "987654321"]);
    expect(parseTelegramOwnerUserIds(" 42 ")).toEqual(["42"]);
  });

  it("returns no IDs for an empty value", () => {
    expect(parseTelegramOwnerUserIds("")).toEqual([]);
    expect(parseTelegramOwnerUserIds(" , ,")).toEqual([]);
  });

  it("drops entries that are not plain numbers instead of failing", () => {
    expect(parseTelegramOwnerUserIds("abc, 123, 45x, -7, 1.5")).toEqual(["123"]);
  });

  it("dedupes repeated IDs", () => {
    expect(parseTelegramOwnerUserIds("7,7, 8, 7")).toEqual(["7", "8"]);
  });
});

describe("ServiceCredentialsUpdateSchema telegramOwnerUserIds", () => {
  it("accepts a comma-separated list and an empty value", () => {
    expect(
      ServiceCredentialsUpdateSchema.safeParse({ telegramOwnerUserIds: "123, 456" }).success,
    ).toBe(true);
    expect(ServiceCredentialsUpdateSchema.safeParse({ telegramOwnerUserIds: "" }).success).toBe(
      true,
    );
    expect(ServiceCredentialsUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("rejects anything that is not numbers, commas and spaces", () => {
    for (const value of ["abc", "123; DROP", "12a", "@owner"]) {
      expect(
        ServiceCredentialsUpdateSchema.safeParse({ telegramOwnerUserIds: value }).success,
        value,
      ).toBe(false);
    }
  });
});
