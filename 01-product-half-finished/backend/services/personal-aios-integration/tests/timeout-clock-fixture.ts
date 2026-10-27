import type {TestContext} from 'node:test';

// Observe timer installation before advancing it: ticking at the failing I/O callback is too early.
export function timeoutClock(t:TestContext){
  t.mock.timers.enable({apis:['setTimeout']});
  const timeout=setTimeout,queued=new Map<number,number>(),waiters=new Map<number,(()=>void)[]>();
  t.mock.method(globalThis,'setTimeout',((callback:(...args:unknown[])=>void,delay=0,...args:unknown[])=>{
    const timer=timeout(()=>callback(...args),delay),waiting=waiters.get(delay)?.shift();
    if(waiting)waiting();else queued.set(delay,(queued.get(delay)??0)+1);
    return timer;
  }) as typeof setTimeout);
  return {tick:(delay:number)=>t.mock.timers.tick(delay),async scheduled(delay:number){
    const count=queued.get(delay)??0;
    if(count)queued.set(delay,count-1);
    else await new Promise<void>(resolve=>{const list=waiters.get(delay)??[];list.push(resolve);waiters.set(delay,list);});
  }};
}
