"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.html"), "utf8");

test("home membership and bank sections load independently before showing data or empty states", () => {
  const membershipCode = renderer.slice(
    renderer.indexOf("function homeMembershipTeam()"),
    renderer.indexOf("function formatHomeComplianceDate("),
  );
  const bankCode = renderer.slice(
    renderer.indexOf("function bankAccountStatusClass("),
    renderer.indexOf("function saveHomeTaxState("),
  );
  const state = {
    authenticated: true,
    homeAccountInfo: null,
    homeBusinessStatus: null,
    homeOverviewCache: {
      account: { loaded: false, loading: false },
      business: { loaded: false, loading: false },
    },
    escapeHTML: value => String(value),
    formatAccountDate: value => value || "—",
    accountStatusText: value => value || "正常",
    bankCountryLabel: value => value || "—",
  };
  const sections = vm.runInNewContext(
    `${membershipCode}\n${bankCode}\n({ membership: renderHomeMembershipDetails, bank: renderHomeBankSection })`,
    state,
  );

  assert.match(sections.membership(), /home-membership-loading.*role="status".*loading-spinner/);
  assert.match(sections.bank(), /home-bank-loading.*role="status".*loading-spinner/);
  assert.doesNotMatch(sections.bank(), /data-home-action="add-bank"/);

  state.homeOverviewCache.business.loaded = true;
  state.homeBusinessStatus = { success: true, bankAccounts: [], pendingBankAccounts: [] };
  assert.match(sections.bank(), /data-home-action="add-bank"/);
  assert.doesNotMatch(sections.bank(), /loading-spinner/);
  assert.match(sections.membership(), /loading-spinner/);

  state.homeOverviewCache.account.loaded = true;
  state.homeAccountInfo = { account: { name: "Tester" }, teams: [{ id: "TEAM123", status: "正常" }] };
  assert.match(sections.membership(), /Tester/);
  assert.doesNotMatch(sections.membership(), /loading-spinner/);

  state.homeBusinessStatus = { success: false };
  state.homeOverviewCache.business.loading = true;
  assert.match(sections.bank(), /home-bank-loading/);
  state.homeOverviewCache.business.loading = false;
  assert.equal(sections.bank(), "");

  state.homeAccountInfo = { error: "没有团队" };
  assert.match(sections.membership(), /没有团队/);
  assert.doesNotMatch(sections.membership(), /loading-spinner/);
  state.homeOverviewCache.account.loading = true;
  assert.match(sections.membership(), /home-membership-loading/);
});

test("home tax section shows a spinner while business tax data loads", () => {
  const taxCode = renderer.slice(
    renderer.indexOf("function renderHomeTaxSection()"),
    renderer.indexOf("function bindHomeTaxEvents("),
  );
  const state = {
    authenticated: true,
    homeBusinessStatus: null,
    homeOverviewCache: { business: { loaded: false, loading: false } },
    homeTaxState: { added: false },
    homeTaxRows: () => [],
    homeTaxCanAddOptionalCountry: () => false,
  };
  const renderTax = vm.runInNewContext(`${taxCode}\nrenderHomeTaxSection`, state);

  assert.match(renderTax(), /home-tax-loading.*role="status".*loading-spinner/);
  assert.doesNotMatch(renderTax(), /data-home-tax-action="open-add"/);

  state.homeOverviewCache.business.loaded = true;
  state.homeBusinessStatus = { success: true };
  assert.match(renderTax(), /点击“添加”选择需要填写的税务表/);
  assert.doesNotMatch(renderTax(), /loading-spinner/);

  state.homeOverviewCache.business.loading = true;
  assert.match(renderTax(), /home-tax-loading/);
  assert.doesNotMatch(renderTax(), /data-home-tax-action="open-add"/);
  state.homeOverviewCache.business.loading = false;
  state.homeBusinessStatus = { success: false };
  assert.equal(renderTax(), "");
});

test("home opens with local loading states visible", () => {
  const titles = renderer.slice(renderer.indexOf("const PAGE_LOADING_TITLES ="), renderer.indexOf("let homeCountryPopoverOutsideHandler"));
  assert.doesNotMatch(titles, /home:\s*"正在加载首页/);
  assert.match(html, /\.home-membership-loading\{min-height:200px;display:grid;place-items:center\}/);
  assert.match(html, /\.home-bank-loading \.loading-spinner/);
  assert.match(html, /\.home-tax-loading \.loading-spinner/);
});
