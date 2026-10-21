import { readFileSync } from 'node:fs';
export const siteWorkSteps = Object.freeze(JSON.parse(readFileSync(new URL('../shared/site-work-steps.json', import.meta.url), 'utf8')).map(Object.freeze));
export const isStepCategory = category => category === 'work_photos' || category === 'work_videos';
