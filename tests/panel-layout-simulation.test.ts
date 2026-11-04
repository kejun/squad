import { expect, it } from 'vitest';
import { simulatePanelDrags } from './panel-layout-simulation.js';

it('[BT_P15] keeps the chat usable over the bounded drag transition matrix', () => {
  const report = simulatePanelDrags();
  expect(report.transitions).toBe(90);
});
