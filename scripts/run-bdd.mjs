import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('test-results', { recursive: true });
const tags = ['@BT_H01','@BT_H02','@BT_H03','@BT_H04','@BT_H05','@BT_H06','@BT_H07','@BT_H08','@BT_H09','@BT_C04','@BT_C06','@BT_C09','@BT_C11','@BT_E01'].join(' or ');
const run = spawnSync(process.execPath, ['--import','tsx','node_modules/@cucumber/cucumber/bin/cucumber.js','features','--import','tests/bdd/steps.ts','--tags',tags,'--format','progress','--format','json:test-results/cucumber.json'], { stdio: 'inherit', timeout: 60000 });
if (run.error) console.error(run.error);
process.exit(run.status ?? 1);
