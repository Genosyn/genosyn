import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import type { FinanceAccess } from "../db/entities/Membership.js";
import type { Role } from "../db/entities/Membership.js";
import {
  effectiveFinanceAccess,
  requireFinanceRead,
  requireFinanceWrite,
} from "./financeAccess.js";

function mockReq(companyRole: Role | undefined, financeAccess?: FinanceAccess): Request {
  return {
    companyRole,
    membership: financeAccess ? { financeAccess } : undefined,
  } as unknown as Request;
}

function mockRes() {
  const res = {
    statusCode: 0 as number,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as typeof res & Response;
}

function run(mw: (req: Request, res: Response, next: () => void) => void, req: Request) {
  const res = mockRes();
  let nexted = false;
  mw(req, res as unknown as Response, () => {
    nexted = true;
  });
  return { res, nexted };
}

describe("effectiveFinanceAccess", () => {
  test("owners and admins are always full, regardless of the column", () => {
    assert.equal(effectiveFinanceAccess(mockReq("owner", "none")), "full");
    assert.equal(effectiveFinanceAccess(mockReq("admin", "read")), "full");
  });

  test("members get exactly their column", () => {
    assert.equal(effectiveFinanceAccess(mockReq("member", "none")), "none");
    assert.equal(effectiveFinanceAccess(mockReq("member", "read")), "read");
    assert.equal(effectiveFinanceAccess(mockReq("member", "full")), "full");
  });

  test("a missing membership fails closed to none", () => {
    assert.equal(effectiveFinanceAccess(mockReq("member", undefined)), "none");
  });
});

describe("requireFinanceRead", () => {
  test("blocks a none member with 403", () => {
    const { res, nexted } = run(requireFinanceRead, mockReq("member", "none"));
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });

  test("lets read and full through", () => {
    assert.equal(run(requireFinanceRead, mockReq("member", "read")).nexted, true);
    assert.equal(run(requireFinanceRead, mockReq("member", "full")).nexted, true);
    assert.equal(run(requireFinanceRead, mockReq("owner", "none")).nexted, true);
  });
});

describe("requireFinanceWrite", () => {
  test("blocks none and read members with 403", () => {
    const none = run(requireFinanceWrite, mockReq("member", "none"));
    assert.equal(none.nexted, false);
    assert.equal(none.res.statusCode, 403);

    const read = run(requireFinanceWrite, mockReq("member", "read"));
    assert.equal(read.nexted, false);
    assert.equal(read.res.statusCode, 403);
  });

  test("lets full members and owners/admins through", () => {
    assert.equal(run(requireFinanceWrite, mockReq("member", "full")).nexted, true);
    assert.equal(run(requireFinanceWrite, mockReq("owner", "read")).nexted, true);
    assert.equal(run(requireFinanceWrite, mockReq("admin", "none")).nexted, true);
  });
});
