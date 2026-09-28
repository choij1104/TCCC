/**
 * TCCC FIELD — full-lifecycle scenario verification
 *
 *   DAY=1 N=22 node test/lifecycle.mjs            -> JSON report on stdout
 *   Requires Playwright (npm install playwright).
 *
 * One scenario = one casualty carried from point of injury to handoff:
 *   injury -> triage/MOI/wound zones -> MARCH -> serial vitals (x3) -> tourniquet(s) -> TXA ->
 *   blood product -> GCS -> MIST report -> 9-line MEDEVAC request -> export -> import into
 *   TCCC COMMAND -> reload persistence.
 * Seeded by DAY so any day can be re-run exactly. Runs offline. Judges record integrity and
 * report content, not clinical decisions. Survival is NOT simulated or predicted.
 *
 * Checks
 *   L1  no page errors (FIELD and COMMAND)
 *   L2  casualty, triage, MOI and wound zones stored
 *   L3  MARCH steps all recorded
 *   L4  three serial vital sets stored in order
 *   L5  every tourniquet recorded with a time
 *   L6  TXA dose logged as a drug entry
 *   L7  blood product count stored
 *   L8  GCS total = E + V + M
 *   L9  MIST report contains HR, GCS and the TXA entry
 *   L10 9-line built with the entered grid, frequency and call sign
 *   L11 9-line Line 3 precedence letter and name form a valid doctrinal pair
 *        (A Urgent, B Urgent-Surgical, C Priority, D Routine, E Convenience). Which precedence
 *        each triage category should map to is a clinical decision and is not judged here.
 *   L12 COMMAND imports the casualty with the same triage, heart rate and tourniquet count
 *   L13 record survives a reload
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIELD = 'file://' + resolve(HERE, '..', 'index.html');
const COMMAND = 'file://' + resolve(HERE, '..', 'TCCC_COMMAND.html');
const EXEC = process.env.CHROME_PATH || undefined;
const DAY = parseInt(process.env.DAY || '1', 10);
const N = parseInt(process.env.N || '22', 10);
const VIEWPORTS = [[390, 844], [768, 1024], [1440, 1000]];
const VALID_PRECEDENCE = /\b(A\s*[—-]\s*URGENT(?![- ]SURGICAL)|B\s*[—-]\s*URGENT[- ]SURGICAL|C\s*[—-]\s*PRIORITY|D\s*[—-]\s*ROUTINE|E\s*[—-]\s*CONVENIENCE)\b/i;

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
const report = { app: 'tccc-field-lifecycle', day: DAY, n: N, started: new Date().toISOString(), scenarios: [] };

for (let i = 0; i < N; i++) {
  const r = rng(90000 + DAY * 1000 + i);
  const vitals = Array.from({ length: 3 }, () => ({
    hr: between(r, 40, 170), spo2: between(r, 70, 100), sbp: between(r, 60, 170), dbp: between(r, 30, 100), rr: between(r, 6, 40),
  }));
  const sc = {
    id: `D${String(DAY).padStart(2, '0')}-L${String(i + 1).padStart(2, '0')}`,
    triage: pick(r, ['T1', 'T2', 'T3', 'T4']), moi: pick(r, MOI),
    zones: [...new Set(Array.from({ length: between(r, 1, 3) }, () => pick(r, ['Head', 'Face', 'L Chest', 'Abdomen', 'L Thigh', 'L Upper Arm', 'L Forearm', 'Back/Spine'])))],
    vitals, gcs: { e: between(r, 1, 4), v: between(r, 1, 5), m: between(r, 1, 6) },
    tqs: Array.from({ length: between(r, 0, 2) }, () => pick(r, TQ_SITES)),
    wb: between(r, 0, 2),
    grid: `14R PU ${between(r, 10000, 99999)} ${between(r, 10000, 99999)}`, freq: `${between(r, 30, 87)}.${between(r, 0, 975)}`, callsign: pick(r, ['DUSTOFF 21', 'VIPER 6', 'BRAVO 3', 'REAPER 11']),
  };
  const [w, h] = VIEWPORTS[i % VIEWPORTS.length];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('FIELD: ' + e.message));
  page.on('dialog', d => d.dismiss());
  await page.goto(FIELD);
  await ctx.setOffline(true);
  await page.waitForTimeout(600);

  const res = await page.evaluate(async s => {
    DB.patients = []; DB.activeId = null; saveDB();
    newPatient();
    const pt = activePt();
    if (!pt) return { fatal: 'no casualty' };
    pt.name = 'SIM ' + s.id; pt.blood = 'O POS';
    setTriage(s.triage);
    setMOI(s.moi, null);
    for (const z of s.zones) { const el = document.querySelector(`[data-z="${z}"]`); if (el) toggleZone(el); }
    for (const L of ['M', 'A', 'R', 'C', 'H']) if (!pt.march[L]) toggleMarch(L);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
    for (const v of s.vitals) { set('i-hr', v.hr); set('i-spo2', v.spo2); set('i-sbp', v.sbp); set('i-dbp', v.dbp); set('i-rr', v.rr); saveVitals(); }
    for (const site of s.tqs) deployTQ(site);
    openDrug('TXA', 'test'); set('dm-dose', '2 g'); const rt = document.getElementById('dm-route'); if (rt) rt.value = rt.options[0] ? rt.options[0].value : ''; confirmDrug();
    for (let k = 0; k < s.wb; k++) adjBlood('wb', 1);
    gcs.e = s.gcs.e; gcs.v = s.gcs.v; gcs.m = s.gcs.m; saveGCS();
    autoFillMIST(); await new Promise(r => setTimeout(r, 250));
    const mist = (document.getElementById('mist-output') || {}).textContent || '';
    set('mvac-grid', s.grid); set('mvac-freq', s.freq); set('mvac-callsign', s.callsign);
    buildNineLine();
    const nine = (document.getElementById('mvac-output') || {}).textContent || '';
    const payload = JSON.stringify(buildCommandPayload());
    return {
      triage: pt.triage, moi: pt.moi, zones: [...(pt.zones || [])], march: { ...pt.march },
      hist: (pt.vitalHistory || []).map(v => v.hr), tqs: pt.tqs.map(q => q.deployStr),
      txa: (pt.logs || []).some(e => e.type === 'drug' && /TXA/.test(e.text)), wb: (pt.bloodProducts || {}).wb,
      gcsTotal: pt.vitals.gcs, mist, nine, payload, id: pt.id,
    };
  }, sc);

  let checks;
  if (res.fatal) checks = { L2_created: false };
  else {
    await page.reload(); await page.waitForTimeout(500);
    const persisted = await page.evaluate(id => DB.patients.some(p => p.id === id), res.id);
    const cmd = await ctx.newPage();
    cmd.on('pageerror', e => errors.push('COMMAND: ' + e.message));
    cmd.on('dialog', d => d.dismiss());
    await cmd.goto(COMMAND); await cmd.waitForTimeout(500);
    const imported = await cmd.evaluate(p => {
      try {
        const n = importPatientsPayload(JSON.parse(p), 'SIM');
        const got = _allPatients[_allPatients.length - 1];
        return { n, triage: got && got.pt.triage, hr: got && got.pt.vitals && got.pt.vitals.hr, tqs: got && got.pt.tqs ? got.pt.tqs.length : -1 };
      } catch (e) { return { err: e.message }; }
    }, res.payload);
    const line3 = (res.nine.split('\n').find(l => /LINE 3/.test(l)) || '');
    const last = sc.vitals[sc.vitals.length - 1];
    checks = {
      L1_no_errors: errors.length === 0,
      L2_record: res.triage === sc.triage && res.moi === sc.moi && sc.zones.every(z => res.zones.includes(z)),
      L3_march: Object.values(res.march).every(Boolean),
      L4_serial_vitals: res.hist.length === 3 && res.hist.map(String).join() === sc.vitals.map(v => String(v.hr)).join(),
      L5_tq: res.tqs.length === sc.tqs.length && res.tqs.every(Boolean),
      L6_txa: res.txa,
      L7_blood: Number(res.wb || 0) === sc.wb,
      L8_gcs: Number(res.gcsTotal) === sc.gcs.e + sc.gcs.v + sc.gcs.m,
      L9_mist: res.mist.includes('HR ' + last.hr) && res.mist.includes('GCS ' + (sc.gcs.e + sc.gcs.v + sc.gcs.m)) && /TXA/.test(res.mist),
      L10_nine_line: res.nine.includes(sc.grid) && res.nine.includes(sc.freq) && res.nine.includes(sc.callsign),
      L11_precedence_valid_pair: VALID_PRECEDENCE.test(line3),
      L12_command_handoff: imported.n === 1 && imported.triage === sc.triage && String(imported.hr) === String(last.hr) && imported.tqs === sc.tqs.length,
      L13_persisted: persisted,
    };
    report.scenarios.push({ ...sc, viewport: `${w}x${h}`, line3, checks, pass: Object.values(checks).every(Boolean),
      errors: errors.slice(0, 3), failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k) });
    await ctx.close();
    continue;
  }
  report.scenarios.push({ ...sc, checks, pass: false, failed: Object.keys(checks) });
  await ctx.close();
}
await browser.close();

const s = report.scenarios;
const byCheck = {};
for (const x of s) for (const [k, v] of Object.entries(x.checks)) { byCheck[k] = byCheck[k] || { pass: 0, fail: 0 }; byCheck[k][v ? 'pass' : 'fail']++; }
report.summary = {
  scenarios: s.length, passed: s.filter(x => x.pass).length,
  byCheck,
  failed: s.filter(x => !x.pass).map(x => ({ id: x.id, triage: x.triage, failed: x.failed })),
};
console.log(JSON.stringify(report, null, 1));
process.exit(report.summary.failed.length ? 1 : 0);
