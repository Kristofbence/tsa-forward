#!/usr/bin/env node
/* TSA Forward Collector — paper-tests "buy the ~24h favorite at the ask, hold to settlement".
   No secrets, no auth: public Kalshi API only. Persists to forward/state.json + forward/results.csv.
   Run once a day at a consistent time. Idempotent: one capture per city/event. */
const K="https://api.elections.kalshi.com/trade-api/v2";
const fs=require("fs"), path=require("path");
const DIR=__dirname, STATE=path.join(DIR,"state.json"), CSV=path.join(DIR,"results.csv");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function kf(u,t=5){for(let i=0;i<t;i++){try{const r=await fetch(u);if(r.status===429){await sleep(700*(i+1));continue;}if(!r.ok){await sleep(300*(i+1));continue;}return await r.json();}catch(e){await sleep(300*(i+1));}}return null;}
const fee=p=>Math.ceil(0.07*p*(1-p)*100)/100;            // Kalshi trading fee per contract
const brk=m=>m.strike_type==="less"?`<${m.cap_strike}`:m.strike_type==="greater"?`>${m.floor_strike}`:`${m.floor_strike}-${m.cap_strike}`;

// LIVE candidates (survived backtest split) + CONTROLS (should stay flat/negative if edge is real)
const CITIES=[
  {ser:"KXHIGHDEN", name:"Denver",  role:"LIVE"},
  {ser:"KXHIGHTDC", name:"DC",      role:"LIVE"},
  {ser:"KXHIGHTPHX",name:"Phoenix", role:"CONTROL"},
  {ser:"KXHIGHCHI", name:"Chicago", role:"CONTROL"},
];

async function quote(ser,tk){                            // returns {bid,ask,mid} in dollars, from the live book
  const ob=await kf(`${K}/markets/${tk}/orderbook`); await sleep(150);
  const o=(ob&&(ob.orderbook_fp||ob.orderbook))||{};
  const yes=(o.yes_dollars||o.yes||[]).map(r=>+r[0]).filter(x=>x>0);
  const no =(o.no_dollars ||o.no ||[]).map(r=>+r[0]).filter(x=>x>0);
  const bid=yes.length?Math.max(...yes):null;            // best price to SELL yes
  const ask=no.length ?+(1-Math.max(...no)).toFixed(2):null; // best price to BUY yes = 1 - best no bid
  if(bid==null&&ask==null)return null;
  const mid=(bid!=null&&ask!=null)?(bid+ask)/2:(ask!=null?ask:bid);
  return {bid,ask:ask!=null?ask:mid,mid};
}

(async()=>{
  let state=[]; try{state=JSON.parse(fs.readFileSync(STATE,"utf8"));}catch(e){}
  const now=Date.now(), nowIso=new Date().toISOString();
  let captured=0;

  // ---- 1) CAPTURE: snapshot the event closing ~24h out, pick the favorite at the ask
  for(const c of CITIES){
    const j=await kf(`${K}/markets?series_ticker=${c.ser}&status=open&limit=400`); await sleep(150);
    const mk=(j&&j.markets)||[]; if(!mk.length)continue;
    const evs={}; mk.forEach(m=>{(evs[m.event_ticker]=evs[m.event_ticker]||[]).push(m);});
    // event whose close is closest to now+24h, within a sane 10-40h window
    let best=null,bd=1e9;
    for(const [et,arr] of Object.entries(evs)){const lead=(new Date(arr[0].close_time)-now)/3.6e6;
      if(lead<10||lead>40)continue; const d=Math.abs(lead-24); if(d<bd){bd=d;best={et,arr,lead};}}
    if(!best)continue;
    if(state.some(r=>r.city===c.name&&r.event===best.et))continue;  // already captured this event
    const qs=[]; for(const m of best.arr){const q=await quote(c.ser,m.ticker); if(q)qs.push({m,q});}
    if(qs.length<3)continue;
    const fav=qs.slice().sort((a,b)=>b.q.mid-a.q.mid)[0];
    state.push({capturedAt:nowIso, city:c.name, ser:c.ser, role:c.role, event:best.et,
      favTicker:fav.m.ticker, bracket:brk(fav.m), leadHours:+best.lead.toFixed(1),
      askCents:Math.round(fav.q.ask*100), midCents:Math.round(fav.q.mid*100),
      bidCents:fav.q.bid!=null?Math.round(fav.q.bid*100):null,
      closeTime:fav.m.close_time, status:"OPEN", result:null, pnl:null});
    captured++;
    console.log(`captured ${c.name} ${best.et} fav ${brk(fav.m)} @ ask ${Math.round(fav.q.ask*100)}c (lead ${best.lead.toFixed(1)}h)`);
  }

  // ---- 2) GRADE: settle any open captures whose markets have resolved
  let graded=0;
  for(const c of CITIES){
    const open=state.filter(r=>r.city===c.name&&r.status==="OPEN");
    if(!open.length)continue;
    const j=await kf(`${K}/markets?series_ticker=${c.ser}&status=settled&limit=200`); await sleep(150);
    const byTk={}; ((j&&j.markets)||[]).forEach(m=>byTk[m.ticker]=m);
    for(const r of open){const m=byTk[r.favTicker]; if(!m||!m.result)continue;
      const won=m.result==="yes"; const ask=r.askCents/100; const cost=ask+fee(ask);
      r.status=won?"WON":"LOST"; r.result=m.result; r.pnl=+(((won?1:0)-cost)).toFixed(4);
      graded++; console.log(`graded ${r.city} ${r.event} -> ${r.status} (pnl ${r.pnl})`);
    }
  }

  // ---- 3) PERSIST
  fs.writeFileSync(STATE, JSON.stringify(state,null,2));
  const hdr="capturedAt,city,role,event,bracket,leadHours,askCents,midCents,status,result,pnl";
  const rows=state.map(r=>[r.capturedAt,r.city,r.role,r.event,r.bracket,r.leadHours,r.askCents,r.midCents,r.status,r.result,r.pnl].join(","));
  fs.writeFileSync(CSV,[hdr,...rows].join("\n"));

  // ---- 4) SUMMARY
  console.log(`\n=== run ${nowIso} | captured ${captured}, graded ${graded}, total rows ${state.length} ===`);
  for(const c of CITIES){const rs=state.filter(r=>r.city===c.name);const set=rs.filter(r=>r.status!=="OPEN");
    const w=set.filter(r=>r.status==="WON").length;
    const pnl=set.reduce((a,r)=>a+(r.pnl||0),0);const cost=set.reduce((a,r)=>a+(r.askCents/100+fee(r.askCents/100)),0);
    console.log(`  ${c.name.padEnd(8)}[${c.role}] open ${rs.filter(r=>r.status==="OPEN").length}  settled ${set.length}  win ${set.length?Math.round(w/set.length*100):0}%  ROI@ask ${cost>0?(pnl/cost*100).toFixed(0):"--"}%`);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
