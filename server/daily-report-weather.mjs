import { z } from 'zod';
import { readFileSync } from 'node:fs';

export const reportPreset = JSON.parse(readFileSync(new URL('../shared/daily-report-preset.json', import.meta.url), 'utf8'));
export const weatherLocationSchema = z.object({ name: z.string().trim().min(1).max(100), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict();
export const weatherInfoSchema = z.object({ date: z.iso.date(), latitude: z.number(), longitude: z.number(), source: z.literal('Open-Meteo'), sourceUrl: z.literal('https://open-meteo.com/'), kind: z.enum(['forecast','recent-history','historical']), condition: z.string().max(60), fetchedAt: z.iso.datetime(), temperatureMin: z.number().nullable(), temperatureMax: z.number().nullable() }).strict();
const codes = { 0:'晴', 1:'晴间多云', 2:'多云', 3:'阴', 45:'雾', 48:'冻雾', 51:'小毛毛雨', 53:'毛毛雨', 55:'大毛毛雨', 56:'轻冻毛毛雨', 57:'冻毛毛雨', 61:'小雨', 63:'中雨', 65:'大雨', 66:'轻冻雨', 67:'冻雨', 71:'小雪', 73:'中雪', 75:'大雪', 77:'雪粒', 80:'小阵雨', 81:'阵雨', 82:'强阵雨', 85:'小阵雪', 86:'强阵雪', 95:'雷雨', 96:'雷雨伴冰雹', 97:'强雷雨', 99:'强雷雨伴冰雹' };
export const shanghaiDate = now => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
export class WeatherError extends Error { constructor(message, status=503) { super(message); this.status=status; } }

export function createWeatherService({ fetcher=fetch, now=() => new Date(), apiKey=process.env.WEATHER_API_KEY || '' }={}) {
  const cache = new Map(), pending = new Map();
  return async ({ date, latitude, longitude }) => {
    const day = Date.parse(date), today = Date.parse(shanghaiDate(now()));
    if (!Number.isFinite(day) || date < '1940-01-01' || day > today + 15*86400000) throw new WeatherError('该日期暂不在天气资料范围内，请按现场记录填写', 400);
    const kind = day >= today ? 'forecast' : day < today - 5*86400000 ? 'historical' : 'recent-history';
    const key = `${kind}/${date}/${latitude}/${longitude}`;
    const cached = cache.get(key); if (cached && cached.until > now().getTime()) return cached.data;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const archive = kind === 'historical';
      const prefix = apiKey ? 'customer-' : '';
      const host = `${prefix}${archive ? 'archive-api' : 'api'}.open-meteo.com`;
      const url = new URL(`https://${host}/v1/${archive ? 'archive' : 'forecast'}`);
      for (const [k,v] of Object.entries({ latitude, longitude, start_date:date, end_date:date, daily:'weather_code,temperature_2m_min,temperature_2m_max', timezone:'Asia/Shanghai' })) url.searchParams.set(k, String(v));
      if (apiKey) url.searchParams.set('apikey', apiKey);
      try {
        const response = await fetcher(url, { signal:AbortSignal.timeout(8000) });
        if (!response.ok) throw new WeatherError('天气服务暂时不可用，可重试或按现场记录填写');
        const body = await response.json();
        const index = body.daily?.time?.indexOf(date) ?? -1;
        const code = body.daily?.weather_code?.[index];
        if (index < 0 || !Number.isInteger(code) || !codes[code]) throw new WeatherError('该日期尚无完整天气资料，请稍后重试或按现场记录填写');
        const number = value => Number.isFinite(value) ? Math.round(value*10)/10 : null;
        const data = { date, latitude, longitude, source:'Open-Meteo', sourceUrl:'https://open-meteo.com/', kind, condition:codes[code], fetchedAt:now().toISOString(), temperatureMin:number(body.daily.temperature_2m_min?.[index]), temperatureMax:number(body.daily.temperature_2m_max?.[index]) };
        if (cache.size >= 200) cache.delete(cache.keys().next().value);
        cache.set(key, { data, until:now().getTime() + (archive ? 24*3600000 : 10*60000) });
        return data;
      } catch (error) { if (error instanceof WeatherError) throw error; throw new WeatherError('天气获取失败，填写内容已保留，可重试或按现场记录填写'); }
    })();
    pending.set(key, work); try { return await work; } finally { pending.delete(key); }
  };
}

export function newReport(date=shanghaiDate(new Date())) {
  const section = s => ({ ...s, todayProgress:'', cumulativeProgress:'', works:(s.kind==='meter' ? [['水表更换','块']] : reportPreset.operations).map(([name,unit]) => ({name,unit,quantity:''})), todayNotes:'', machinery:'', workers:'', security:'', tomorrow:'', procedures:'', difficulties:'' });
  return { projectName:reportPreset.projectName, region:reportPreset.region, reportDate:date, number:'', weather:'', weatherAuto:true, weatherLocation:{...reportPreset.weatherLocation}, sections:[section(reportPreset.sections[0])], nextPlan:'', otherItems:'', photos:[] };
}

export function mountReportWeather(app, { auth, mobileAuth, service=createWeatherService() }) {
  const coordinates = (min,max) => z.coerce.number().min(min).max(max);
  const schema = z.object({ date:z.iso.date(), latitude:coordinates(-90,90), longitude:coordinates(-180,180) }).strict();
  const weather = async (req,res) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success || req.query.latitude === '' || req.query.longitude === '') return res.status(400).json({ error:'请填写有效的施工日期和项目经纬度' });
    try { res.json(await service(parsed.data)); } catch (error) { res.status(error.status || 503).json({ error:error.message || '天气暂不可用' }); }
  };
  app.get('/api/daily-report/template', auth, (req,res) => res.json(newReport()));
  app.get('/api/daily-report/weather', auth, weather);
  if (mobileAuth) {
    app.get('/api/mobile/daily-report/template', mobileAuth, (req,res) => res.json(newReport()));
    app.get('/api/mobile/daily-report/weather', mobileAuth, weather);
  }
}
