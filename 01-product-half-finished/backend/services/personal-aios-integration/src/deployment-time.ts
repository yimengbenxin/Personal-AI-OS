/** The sole default for standalone provisioning; cloud rendering freezes the deployer's zone. */
export const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function deploymentTimeZone(value: string = DEFAULT_TIME_ZONE): string {
  new Intl.DateTimeFormat('en-US', {timeZone: value}).format(0);
  return value;
}
/** CLDR names preserve the existing Taiwanese wording and follow every configured IANA zone. */
export const timeZoneName = (zone: string) => new Intl.DateTimeFormat('zh-CN', {timeZone: zone, timeZoneName: 'shortGeneric'})
  .formatToParts(0).find(part => part.type === 'timeZoneName')!.value;
/** Local ISO timestamp with the offset at the instant, including daylight-saving changes. */
export function zonedTimestamp(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset'})
    .formatToParts(ms);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName!.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${p.fractionalSecond}${offset}`;
}
