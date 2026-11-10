'use strict';

// 情境判决研究模型。分数是证据一致度，不是收益概率；阈值属于建模定义，尚待前瞻验证。
const UNIFIED_RULES = Object.freeze({
  version: 'unified-2.0.0', status: '待前瞻验证',
  weights: Object.freeze({ market: 25, identity: 20, structure: 15, commitment: 15, volume: 10, auction: 10, legacy: 5 }),
  confirmationScore: 70, topPriorityScore: 80, minimumCoverage: 65,
  sources: ['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11','S12','S13','S14','L5','L7','L10'],
  principles: ['先看市场与核心，再看相对身位和阶段', '价格与承接确认后再讨论参与', '高位强势与新进场成本分别判断', '单次炸板、封板时间和绝对板数不单独否决', '明确失效与风险约束优先', '分数不映射胜率，缺失证据不当作通过']
});
const number = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const bool = value => typeof value === 'boolean' ? value : null;
const clamp = value => Math.max(0, Math.min(1, value));
const unique = values => [...new Set(values.filter(Boolean))];

function sizeByRisk({ equity, riskFraction, entry, stop, maxPositionFraction, lotSize = 100 } = {}) {
  [equity,riskFraction,entry,stop,maxPositionFraction,lotSize] = [equity,riskFraction,entry,stop,maxPositionFraction,lotSize].map(number);
  if (!(equity > 0 && riskFraction > 0 && riskFraction <= 1 && entry > stop && stop > 0 && maxPositionFraction > 0 && maxPositionFraction <= 1 && lotSize > 0)) return { available: false, reason: '需要资金、风险预算、有效失效价和仓位上限' };
  const riskPerShare = entry-stop;
  const shares = Math.floor(Math.min(equity*riskFraction/riskPerShare, equity*maxPositionFraction/entry)/lotSize)*lotSize;
  return { available: true, shares, amount: Number((shares*entry).toFixed(2)), riskAtStop: Number((shares*riskPerShare).toFixed(2)), note: '按给定失效价估算；T+1、跳空和跌停可能使实际风险更大' };
}

function assessUnifiedDecision(stock = {}, context = {}, legacy = null) {
  const market=context.market || {}, identity=context.identity || {}, structure=context.structure || {}, flow=context.commitment || {}, volume=context.volume || {}, auction=context.auction || {};
  const checklist=[], evidence=[], missing=[], hardFails=[], cautions=[];
  const add=(key,label,value,note,sources)=>{
    const known=number(value)!==null, normalized=known?clamp(Number(value)):null;
    const row={dim:key,label,status:!known?'na':normalized>=.7?'pass':normalized<.35?'fail':'warn',note,sources};
    checklist.push(row);evidence.push({key,weight:UNIFIED_RULES.weights[key],value:normalized,note,sources});
    if(!known)missing.push(label);
  };
  const adverse=['退潮初期','退潮','冰点'].includes(market.phase);
  const divergent=['分歧期','高潮转分歧','修复'].includes(market.phase);
  const expanding=['主升期','高潮'].includes(market.phase);
  const core=bool(identity.isCore)===true;
  const sealed=bool(structure.sealed), resealed=bool(structure.resealed);
  const price=number(structure.price), stop=number(structure.invalidationPrice);
  const stage=identity.stage || '阶段待辨识';
  const lateAcceleration=bool(identity.priorAcceleration)===true && identity.relativeHeight===true;
  const repair=bool(market.repairConfirmed)===true;
  const legacyScore=number(legacy?.score);

  if(context.data?.trusted===false)hardFails.push('行情延迟、降级或关键来源不可信');
  if(context.data?.derived===true)hardFails.push('自算行情不能作为真实封板确认');
  if(context.circuitPaused===true)hardFails.push('当前模式处于策略熔断保护');
  if(context.execution?.suspended===true)hardFails.push('停牌或明确无法交易');
  if(context.risk?.blocked===true || context.execution?.riskLimitExceeded===true)hardFails.push('已触发组合或单笔风险限额');
  if(structure.invalidated===true || (price!==null && stop!==null && price<=stop))hardFails.push('价格已跌破本次确认的失效线');

  let marketValue=null;
  if(expanding)marketValue=market.phase==='高潮'?.65:.85;
  else if(divergent)marketValue=repair?.80:.50;
  else if(adverse)marketValue=repair?.65:.20;
  if(marketValue!==null && market.coreState==='collapsed')marketValue=Math.min(marketValue,.25);
  if(marketValue!==null && market.breadthImproving===false)marketValue=Math.max(0,marketValue-.15);
  add('market','市场节奏',marketValue,`${market.phase || '阶段未知'} · 前高度锚${({healthy:'仍封板',collapsed:'已出现跌停反馈',disagreement:'出现分歧',replacing:'新锚正在确认',unknown:'状态未知'})[market.coreState] || '状态未知'}${repair?' · 已出现广度与核心修复证据':''}`,['S3','S6','S8','S10','S11','S12','S14','L5']);

  let identityValue=identity.known===false?null:core?.85:identity.kind==='rear'?.25:.50;
  if(identityValue!==null && identity.heightOnly)identityValue=Math.min(identityValue,.45);
  if(identityValue!==null && identity.sealedAfterPeers===true)identityValue=Math.max(0,identityValue-.10);
  add('identity','地位带动',identityValue,`${identity.label || '地位待辨识'} · ${stage}${identity.heightOnly?'；最高板只证明相对高度，缺少板块支持':''}${identity.sealedAfterPeers?'；首封晚于板块前排，主动性仍需核实':''} · ${identity.source || '来源未明'}`,['S1','S4','S6','S7','S8','S9','S13']);

  const breakout=structure.breakout===true, reclaim=structure.reclaim===true;
  let structureValue=sealed===null?null:sealed?.70:.30;
  if(structureValue!==null && (breakout||reclaim))structureValue=.90;
  if(structure.invalidated)structureValue=0;
  add('structure','价格结构',structureValue,`${sealed===true?'当前价格维持涨停附近':sealed===false?'尚未封住':'现价/封板状态未知'}${breakout?' · 突破此前区间':''}${reclaim?' · 收复此前回落区间':''}${stop!==null?' · 失效参考 '+stop.toFixed(2):' · 失效价待补齐'}`,['S1','S4','S8','L7','L10']);

  const sealRatio=number(flow.sealRatio), thinning=bool(flow.thinning);
  let commitmentValue=sealRatio===null?null:sealRatio>0?.60:.10;
  if(commitmentValue!==null && number(flow.peerMedian)>0)commitmentValue=clamp(.35+.40*(sealRatio/flow.peerMedian));
  if(commitmentValue!==null && sealRatio>0 && resealed===true && thinning!==true)commitmentValue=Math.max(commitmentValue,.75);
  if(commitmentValue!==null && thinning===true)commitmentValue=Math.min(commitmentValue,.40);
  add('commitment','回封承接',commitmentValue,`${resealed===true?'已观察到开板后回封':resealed===false?'未观察到回封过程':'回封时序未知'}${sealRatio!==null?' · 封单/流通 '+sealRatio.toFixed(2)+'%':' · 封单数据缺失'}${thinning===true?' · 较同日上一有效快照变薄':thinning===false?' · 上一有效快照比较未变薄':' · 封单稳定性尚无连续证据'}；静态封单不等于成交保障`,['S1','S2','S3','S7']);

  const effort=number(volume.amountRatio);
  const volumeValue=effort===null?null:volume.comparable===true?clamp(.35+.35*Math.min(effort,2)):effort>=1?clamp(.60+.15*Math.min(effort-1,1)):null;
  add('volume','相对量价',volumeValue,effort===null?'缺少可比历史成交额，不按绝对换手率判断':`当前累计额/此前全日基准 ${effort.toFixed(2)} 倍${volume.comparable?'（收盘可比）':'（盘中不足一倍不作缩量结论）'}；放量须结合价格结果`,['S1','S2','S5']);

  const openPct=number(auction.openPct);
  const auctionValue=openPct===null?null:auction.limitOpen===true?.90:openPct>0?((reclaim||resealed===true)? .85:.65):sealed===true?.60:.25;
  add('auction','竞价预期',auctionValue,openPct===null?'竞价缺失，不能伪装成平开/低开':`今开较昨收 ${openPct.toFixed(2)}%${auction.limitOpen?' · 开盘即涨停，强势与可成交分别判断':openPct<=0 && sealed?' · 低开后已收复，不能只凭开盘否决':''}${auction.previousDisagreement?' · 昨日有分歧记录':''}`,['S1','S2','S11','L10']);

  add('legacy','原始参照',legacyScore===null?null:legacyScore/100,legacyScore===null?'旧规则输入不足':`原规则 ${legacyScore} 分/${legacy.verdict}；原八维证据保留，经验否决须经情境复核`,['legacy']);
  const knownWeight=evidence.reduce((sum,row)=>sum+(row.value===null?0:row.weight),0);
  const score=knownWeight?Math.round(evidence.reduce((sum,row)=>sum+(row.value===null?0:row.value*row.weight),0)/knownWeight*100):null;
  const critical=[];
  if(marketValue===null)critical.push('市场阶段');
  if(context.data?.trusted!==true)critical.push('可信行情状态');
  if(identity.known!==true)critical.push('地位与题材支持');
  if(sealed===null || price===null)critical.push('价格确认');
  if(commitmentValue===null)critical.push('封单承接');
  if(stop===null)critical.push('失效参考价');
  if(Number(stock.boards)>1 && openPct===null)critical.push('连板竞价');
  if(knownWeight<UNIFIED_RULES.minimumCoverage)critical.push('证据覆盖不足');

  const firstBoard=Number(stock.boards)===1;
  const freshConfirmation=resealed===true || reclaim || (sealed===true && core && flow.newConfirmed===true) || (firstBoard && breakout && volumeValue!==null && volumeValue>=.60);
  if(identity.heightOnly)cautions.push('相对高标不自动等于市场龙头');
  if(flow.thinning===true)cautions.push('封单趋薄，需要观察持续承接');
  if(lateAcceleration)cautions.push('连续加速后的新进场缺少成本先手，已有持仓与追入分开');
  if(context.theme?.size===1)cautions.push('板块支持薄，不能因单独涨停认定无风险，也不能断言必败');
  if(identity.source==='行业代理')cautions.push('题材目前使用行业代理，真实概念关系仍需核实');
  if(context.theme?.mainline===false)cautions.push('非当前主线，仍需验证独立逻辑与持续带动');
  if(structure.priceBasisComparable===false)cautions.push('日K与实时价格口径不一致，暂不生成价格失效线');
  if(firstBoard && structure.priorPosition>=.80)cautions.push('首板发生在此前区间较高位置，不能当作天然低位；新高突破仍须验证量价');
  if(auction.previousRepaired===true)cautions.push('昨日已有回封，不能把今日高开自动当作未兑现的弱转强起点');
  if(structure.shapeWarnings?.length)cautions.push('原出场形态有负反馈，需结合当前价格是否收复判断');
  if(legacy?.hardFails?.length)cautions.push('原规则限制已作为风险证据重新审视：'+legacy.hardFails.join('、'));
  if(market.coreState==='collapsed' && !core)hardFails.push('前高度锚出现严重亏钱反馈，后排接力/补涨尚未获得全局确认');
  if(lateAcceleration && thinning===true && (market.breadthImproving===false || context.theme?.weakening===true))hardFails.push('连续加速后封单趋薄且外部支持走弱，新增接力风险共振');
  const conditions=[];
  if(firstBoard && !(breakout && volumeValue!==null && volumeValue>=.60))conditions.push('首板需区间突破与相对成交额证据，或等待后续确认');
  if(!core)conditions.push('需要辨识板块前排和真实带动，避免主观卡位');
  if((adverse||divergent) && !freshConfirmation)conditions.push('分歧/退潮环境需核心回封或收复确认');
  if(adverse && !repair)conditions.push('等待市场广度与高度锚的修复证据');
  if(lateAcceleration && !freshConfirmation)conditions.push('连续加速后等待新增承接确认，不以强势外观直接追入');
  if(sealed!==true)conditions.push('价格需重新确认，当前状态不构成封板确认');
  if(thinning===true)conditions.push('先观察封单与板块支持是否恢复');
  if(structure.shapeWarnings?.length && !breakout && !reclaim)conditions.push('此前形态负反馈尚未由价格收复确认');
  if(market.previousPhase==='高潮' && !freshConfirmation)conditions.push('此前一致行情已兑现，等待新的承接确认');
  if(commitmentValue!==null && commitmentValue<.50)conditions.push('等待更充分的封单与承接证据');
  if(volume.currentAmount===0)conditions.push('等待真实成交与承接数据');
  const eligible=!hardFails.length && !critical.length && !conditions.length && score>=UNIFIED_RULES.confirmationScore;
  const verdict=hardFails.length?'规避':eligible?'可接力':'观望';
  const active=context.execution?.inTradingSession===true;
  const executable=context.execution?.canEnterNow===true;
  const riskConfirmed=context.execution?.riskConfirmed===true;
  const state=hardFails.length?'禁打':eligible?(active&&executable&&riskConfirmed?'可打':'待触发'):'观察';
  const triggers=unique([...conditions,...critical.map(key=>'补齐'+key),...(eligible?[...(active?(executable?[]:['等待实际可成交的承接点']):['下一交易时段重新验证承接']),...(!riskConfirmed?['按失效价确认单笔风险预算和持仓限额']:[])]:[])]);
  const invalidation=unique([...(stop!==null?['价格失效参考 '+stop.toFixed(2)]:['预先确定价格失效线']), '核心与板块同步转弱且无法恢复承接', '突破回落/回封失败时重新评估，不能用龙头标签扛失效']);
  const hold=context.data?.trusted!==true?'数据状态待核，不用旧报价推断趋势；按既定风险计划管理':hardFails.some(reason=>reason.includes('失效线'))?'失效条件已出现，按既定退出计划处理':core?'核心趋势尚未失效时持有观察，不主观猜顶或随意切后排':'按价格与板块失效条件管理，不以补涨标签替代确认';
  const actionPlan={entry:hardFails.length?'当前规避':eligible?(state==='可打'?'成交与风险条件已确认，按既定计划评估执行':'确认条件已具备，等待成交与风险预算确认'):'等待条件，不抢先预测',conditions:triggers,invalidation,hold,add:'仅在已有浮盈、趋势延续且再次确认后评估加仓；亏损不摊低',position:'按资金、失效距离和风险预算定仓；一致度不换算仓位',execution:auction.limitOpen?'封死涨停不视为可成交，不能假设排队成交':'成交条件仍须验证；A股 T+1 不保证当天能执行止损',shapeWarnings:structure.shapeWarnings||[]};
  checklist.unshift({dim:'unified',label:'统一判决',status:verdict==='可接力'?'pass':verdict==='规避'?'fail':'warn',note:`${UNIFIED_RULES.version} · ${UNIFIED_RULES.status} · ${identity.label || '地位待辨识'} / ${stage}`});
  if(critical.length)checklist.push({dim:'coverage',label:'证据缺口',status:'na',note:unique(critical).join('、')});
  return {
    available:context.data?.trusted===true,modelVersion:UNIFIED_RULES.version,validationStatus:UNIFIED_RULES.status,score,scoreMeaning:'情境一致度，非胜率',verdict,
    faultTolerance:null,hardFails:unique(hardFails),downgrades:unique([...critical.map(key=>'待补齐'+key),...cautions]),checklist,
    coverage:{percent:knownWeight,missing:unique([...missing,...critical])},needsHistory:!structure.historyEnd||stop===null,profile:{market:market.phase||'未知',identity:identity.label||'待辨识',stage},
    actionPlan,signal:{state,triggers,risks:unique([...hardFails,...cautions]),next:actionPlan.entry},
    legacy:legacy?{model:'legacy-promo-v1',score:legacyScore,verdict:legacy.verdict,hardFails:legacy.hardFails||[],downgrades:legacy.downgrades||[],checklist:legacy.checklist||[]}:null,
    asOf:context.observedAt||null,disclaimer:'研究判决，尚未证明有效；强势、可成交与可承担风险是三个不同条件'
  };
}

export {UNIFIED_RULES,assessUnifiedDecision,sizeByRisk};
