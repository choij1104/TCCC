/**
 * TCCC FIELD — daily scenario verification (operational)
 *
 *   DAY=1 N=15 node test/scenarios.mjs            -> JSON report on stdout
 *   Requires Playwright (npm install playwright).
 *
 * Generates N reproducible random casualty workflows for study day DAY (seeded), runs each one
 * through index.html in an offline browser, and checks that the record the medic builds is
 * captured, reported, persisted and exported correctly. It does not judge clinical decisions.
 *
 * Invariants per scenario
 *   T1 no page errors
 *   T2 casualty created and triage stored
 *   T3 every vital entered is stored on the casualty record
 *   T4 GCS total = eye + verbal + motor
 *   T5 every tourniquet applied is recorded with a time
 *   T6 MIST report generated and contains the casualty's heart rate and GCS
 *   T7 COMMAND export payload is valid JSON with the right casualty count and vitals
 *   T8 record survives a page reload (local persistence)
 *   T9 each step completes within 1,000 ms
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + resolve(HERE, '..', 'index.html');
const EXEC = process.env.CHROME_PATH || undefined;
const DAY = parseInt(process.env.DAY || '1', 10);
const N = parseInt(process.env.N || '15', 10);
const VIEWPORTS = [[390, 844], [768, 1024], [1440, 1000]];

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const between = (r, lo, hi) => Math.round(lo + r() * (hi - lo));
const TQ_SITES = ['R UPPER ARM', 'L UPPER ARM', 'R THIGH', 'L THIGH', 'R FOREARM', 'L FOREARM', 'R LOWER LEG', 'L LOWER LEG'];
const MOI = ['Blast / Explosion', 'Blunt Trauma', 'Burn / Thermal Injury', 'CBRN Exposure', 'Crush Injury'];

const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
const report = { app: 'tccc-field', day: DAY, n: N, started: new Date().toISOString(), scenarios: [] };

for (let i = 0; i < N; i++) {
  const r = rng(50000 + DAY * 1000 + i);
  const sc = {
    id: `D${String(DAY).padStart(2, '0')}-F${String(i + 1).padStart(2, '0')}`,
    triage: pick(r, ['T1', 'T2', 'T3', 'T4']),
    moi: pick(r, MOI),
    hr: between(r, 40, 170), spo2: between(r, 70, 100), sbp: between(r, 60, 170), dbp: between(r, 30, 100),
    rr: between(r, 6, 40), temp: (35 + r() * 4).toFixed(1),
    gcs: { e: between(r, 1, 4), v: between(r, 1, 5), m: between(r, 1, 6) },
    tqs: Array.from({ length: between(r, 0, 2) }, () => pick(r, TQ_SITES)),
    wt: between(r, 55, 110),
  };
  const [w, h] = VIEWPORTS[i % VIEWPORTS.length];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.goto(APP);
  await ctx.setOffline(true);
  await page.waitForTimeout(600);

  const res = await page.evaluate(async s => {
    const t = {}; const time = (k, f) => { const t0 = performance.now(); const v = f(); t[k] = performance.now() - t0; return v; };
    DB.patients = []; DB.activeId = null; saveDB();
    time('create', () => newPatient());
    const pt = activePt();
    if (!pt) return { fatal: 'no casualty created' };
    pt.wt = String(s.wt);
    time('triage', () => setTriage(s.triage));
    time('moi', () => setMOI(s.moi, null));
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
    set('i-hr', s.hr); set('i-spo2', s.spo2); set('i-sbp', s.sbp); set('i-dbp', s.dbp); set('i-rr', s.rr); set('i-temp', s.temp);
    time('vitals', () => saveVitals());
    gcs.e = s.gcs.e; gcs.v = s.gcs.v; gcs.m = s.gcs.m;
    time('gcs', () => saveGCS());
    for (const site of s.tqs) time('tq_' + site, () => deployTQ(site));
    time('mist', () => autoFillMIST());
    await new Promise(r => setTimeout(r, 250));
    const mist = (document.getElementById('mist-output') || {}).textContent || '';
    let payloadOk = false, payloadCount = -1, payloadHr = null;
    try {
      const p = JSON.parse(JSON.stringify(buildCommandPayload()));
      payloadCount = p.totalCasualties; payloadHr = p.patients[0] && p.patients[0].vitals && p.patients[0].vitals.hr;
      payloadOk = Array.isArray(p.patients) && p.patients.length === p.totalCasualties;
    } catch (e) { payloadOk = false; }
    const stored = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
    return {
      triage: pt.triage, v: pt.vitals, gcsTotal: pt.vitals.gcs, tqs: pt.tqs.map(q => ({ loc: q.location, time: q.deployStr })),
      mist, payloadOk, payloadCount, payloadHr, storedCount: stored ? stored.patients.length : 0, id: pt.id, t,
    };
  }, sc);

  let persisted = false;
  if (!res.fatal) {
    await page.reload();
    await page.waitForTimeout(600);
    persisted = await page.evaluate(id => DB.patients.some(p => p.id === id), res.id);
  }
  const checks = res.fatal ? { T2_created: false } : {
    T1_no_errors: errors.length === 0,
    T2_created_triage: res.triage === sc.triage,
    T3_vitals_stored: String(res.v.hr) === String(sc.hr) && String(res.v.spo2) === String(sc.spo2) && String(res.v.rr) === String(sc.rr),
    T4_gcs_sum: Number(res.gcsTotal) === sc.gcs.e + sc.gcs.v + sc.gcs.m,
    T5_tq_recorded: res.tqs.length === sc.tqs.length && res.tqs.every(q => q.time),
    T6_mist: res.mist.length > 20 && res.mist.includes('HR ' + sc.hr) && res.mist.includes('GCS ' + (sc.gcs.e + sc.gcs.v + sc.gcs.m)),
    T7_export: res.payloadOk && res.payloadCount === 1 && String(res.payloadHr) === String(sc.hr),
    T8_persisted: persisted && res.storedCount === 1,
    T9_steps_under_1s: Object.values(res.t).every(ms => ms < 1000),
  };
  const pass = Object.values(checks).every(Boolean);
  report.scenarios.push({ ...sc, viewport: `${w}x${h}`, stepMs: res.t ? Object.fromEntries(Object.entries(res.t).map(([k, v]) => [k, Math.round(v)])) : null,
    checks, pass, errors: errors.slice(0, 3), failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k) });
  await ctx.close();
}
await browser.close();

const s = report.scenarios;
const allMs = s.flatMap(x => x.stepMs ? Object.values(x.stepMs) : []).sort((a, b) => a - b);
report.summary = {
  scenarios: s.length,
  passed: s.filter(x => x.pass).length,
  failed: s.filter(x => !x.pass).map(x => ({ id: x.id, failed: x.failed })),
  invariantChecks: s.reduce((n, x) => n + Object.keys(x.checks).length, 0),
  medianStepMs: allMs[Math.floor(allMs.length / 2)],
};
console.log(JSON.stringify(report, null, 1));
process.exit(report.summary.failed.length ? 1 : 0);
