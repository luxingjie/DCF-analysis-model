require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const TI = require('technicalindicators');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─── 配置 ─────────────────────────────────────────────────────────────────────
// Tushare Pro 文档：https://tushare.pro/document/2
// 在 .env 文件中写入：TUSHARE_TOKEN=你的token
const TUSHARE_URL = 'http://api.tushare.pro';
const TOKEN = process.env.TUSHARE_TOKEN;

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function safeNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Tushare 统一 POST 请求
// api_name: 接口名，params: 参数对象，fields: 需要的字段（逗号分隔字符串，空则返回全部）
async function tushare(api_name, params = {}, fields = '') {
  if (!TOKEN) {
    throw new Error(
      '未设置 TUSHARE_TOKEN。请在项目目录创建 .env 文件并写入 TUSHARE_TOKEN=你的token'
    );
  }
  const body = { api_name, token: TOKEN, params, fields };
  const res = await axios.post(TUSHARE_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  const { code, msg, data } = res.data;
  if (code !== 0) throw new Error(`Tushare [${api_name}] 错误: ${msg}`);
  return data; // { fields: [...], items: [[...], ...] }
}

// Tushare 返回的列式数据 → 对象数组
function toObjs(data) {
  if (!data?.fields?.length || !data?.items?.length) return [];
  return data.items.map(row => {
    const obj = {};
    data.fields.forEach((f, i) => { obj[f] = row[i]; });
    return obj;
  });
}

// 股票代码规范化（支持纯数字输入，自动补交易所后缀）
// 600519 → 600519.SH | 000858 → 000858.SZ | 300750 → 300750.SZ
function normalizeCode(raw) {
  const t = String(raw).trim().toUpperCase();
  if (t.includes('.')) return t;
  if (/^6\d{5}$/.test(t)) return `${t}.SH`;
  if (/^[03]\d{5}$/.test(t)) return `${t}.SZ`;
  if (/^[48]\d{5}$/.test(t)) return `${t}.BJ`;
  return t;
}

// Date → Tushare 日期格式 YYYYMMDD
function toTDate(d) {
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

// 计算区间起止日期（交易日有时差，多加几天缓冲）
function periodToDates(period = '1y') {
  const end = new Date();
  const daysMap = {
    '1d': 5, '5d': 10, '1mo': 40, '3mo': 100, '6mo': 200,
    '1y': 380, '2y': 750, '5y': 1850, '10y': 3700,
  };
  const days = daysMap[period] ?? 380;
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { start_date: toTDate(start), end_date: toTDate(end) };
}


// ─── 1. 股票基本信息 ─────────────────────────────────────────────────────────
// GET /api/stock/:ticker
// ticker: 600519 | 600519.SH | 000858.SZ
app.get('/api/stock/:ticker', async (req, res) => {
  const tsCode = normalizeCode(req.params.ticker);
  try {
    // 并行: 公司基本信息 + 最近5日行情（取最新一条）+ 最近1条每日指标
    const [basicData, dailyData, dailyBasicData] = await Promise.all([
      tushare('stock_basic', { ts_code: tsCode, list_status: 'L' },
        'ts_code,symbol,name,area,industry,fullname,market,exchange,curr_type,list_date'),
      tushare('daily', { ts_code: tsCode, ...periodToDates('5d') },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount'),
      tushare('daily_basic', { ts_code: tsCode, ...periodToDates('5d') },
        'ts_code,trade_date,close,pe,pe_ttm,pb,ps,ps_ttm,dv_ratio,dv_ttm,total_share,float_share,total_mv,circ_mv'),
    ]);

    const basic = toObjs(basicData)[0] || {};
    const daily = toObjs(dailyData)[0] || {};    // items 已按日期降序，[0] 为最新
    const db    = toObjs(dailyBasicData)[0] || {};

    res.json({
      tsCode,
      ticker: basic.symbol || tsCode,
      name: basic.name || tsCode,
      fullname: basic.fullname || null,
      industry: basic.industry || null,
      area: basic.area || null,
      market: basic.market || null,
      exchange: basic.exchange || null,
      currency: basic.curr_type || 'CNY',
      listDate: basic.list_date || null,
      // 最新行情
      tradeDate: daily.trade_date || null,
      price: safeNum(daily.close),
      open: safeNum(daily.open),
      high: safeNum(daily.high),
      low: safeNum(daily.low),
      preClose: safeNum(daily.pre_close),
      change: safeNum(daily.change),
      changePct: safeNum(daily.pct_chg),         // 涨跌幅 %
      volume: safeNum(daily.vol),                 // 成交量（手）
      amount: safeNum(daily.amount),              // 成交额（千元）
      // 估值指标（来自 daily_basic）
      pe: safeNum(db.pe),
      peTtm: safeNum(db.pe_ttm),
      pb: safeNum(db.pb),
      ps: safeNum(db.ps),
      psTtm: safeNum(db.ps_ttm),
      dividendYield: safeNum(db.dv_ttm),         // 股息率（TTM）%
      totalShare: safeNum(db.total_share),        // 总股本（万股）
      floatShare: safeNum(db.float_share),        // 流通股本（万股）
      totalMv: safeNum(db.total_mv),              // 总市值（万元）
      circMv: safeNum(db.circ_mv),               // 流通市值（万元）
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. 历史K线数据 ──────────────────────────────────────────────────────────
// GET /api/stock/:ticker/history?period=1y&interval=1d
// interval: 1d(日线) | 1w(周线) | 1mo(月线)
app.get('/api/stock/:ticker/history', async (req, res) => {
  const tsCode = normalizeCode(req.params.ticker);
  const { period = '1y', interval = '1d' } = req.query;
  try {
    const { start_date, end_date } = periodToDates(period);
    let rawData;

    if (interval === '1w' || interval === 'weekly') {
      rawData = await tushare('weekly', { ts_code: tsCode, start_date, end_date },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount');
    } else if (interval === '1mo' || interval === 'monthly') {
      rawData = await tushare('monthly', { ts_code: tsCode, start_date, end_date },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount');
    } else {
      // 默认日线
      rawData = await tushare('daily', { ts_code: tsCode, start_date, end_date },
        'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount');
    }

    // Tushare 返回降序，翻转为升序（适合图表）
    const candles = toObjs(rawData).reverse().map(r => ({
      date: r.trade_date,               // YYYYMMDD
      open: safeNum(r.open),
      high: safeNum(r.high),
      low: safeNum(r.low),
      close: safeNum(r.close),
      preClose: safeNum(r.pre_close),
      change: safeNum(r.change),
      changePct: safeNum(r.pct_chg),
      volume: safeNum(r.vol),           // 手
      amount: safeNum(r.amount),        // 千元
    }));

    res.json({ tsCode, period, interval, count: candles.length, candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. 技术指标 ─────────────────────────────────────────────────────────────
// GET /api/stock/:ticker/indicators?period=1y
app.get('/api/stock/:ticker/indicators', async (req, res) => {
  const tsCode = normalizeCode(req.params.ticker);
  const { period = '1y' } = req.query;
  try {
    const { start_date, end_date } = periodToDates(period);
    const rawData = await tushare('daily', { ts_code: tsCode, start_date, end_date },
      'trade_date,open,high,low,close,vol');

    // 升序排列
    const rows = toObjs(rawData).reverse();
    const closes = rows.map(r => safeNum(r.close));
    const highs  = rows.map(r => safeNum(r.high));
    const lows   = rows.map(r => safeNum(r.low));
    const n = rows.length;

    function align(arr) {
      return [...Array(n - arr.length).fill(null), ...arr];
    }

    const ma5   = align(TI.SMA.calculate({ period: 5,   values: closes }));
    const ma10  = align(TI.SMA.calculate({ period: 10,  values: closes }));
    const ma20  = align(TI.SMA.calculate({ period: 20,  values: closes }));
    const ma60  = align(TI.SMA.calculate({ period: 60,  values: closes }));
    const ma120 = align(TI.SMA.calculate({ period: 120, values: closes }));
    const ema12 = align(TI.EMA.calculate({ period: 12,  values: closes }));
    const ema26 = align(TI.EMA.calculate({ period: 26,  values: closes }));
    const rsi   = align(TI.RSI.calculate({ period: 14,  values: closes }));
    const macdRaw = align(TI.MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
      values: closes,
    }));
    const bbRaw   = align(TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: closes }));
    const stochRaw = align(TI.Stochastic.calculate({
      high: highs, low: lows, close: closes, period: 14, signalPeriod: 3,
    }));
    const atr = align(TI.ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }));

    const indicators = rows.map((r, i) => ({
      date: r.trade_date,
      close: closes[i],
      volume: safeNum(r.vol),
      ma5: ma5[i], ma10: ma10[i], ma20: ma20[i], ma60: ma60[i], ma120: ma120[i],
      ema12: ema12[i], ema26: ema26[i],
      rsi: rsi[i],
      macd: macdRaw[i]
        ? { macd: macdRaw[i].MACD, signal: macdRaw[i].signal, histogram: macdRaw[i].histogram }
        : null,
      bb: bbRaw[i]
        ? { upper: bbRaw[i].upper, middle: bbRaw[i].middle, lower: bbRaw[i].lower }
        : null,
      stoch: stochRaw[i] ? { k: stochRaw[i].k, d: stochRaw[i].d } : null,
      atr: atr[i],
    }));

    res.json({ tsCode, period, count: indicators.length, indicators });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. DCF 估值所需财务数据 ─────────────────────────────────────────────────
// GET /api/stock/:ticker/financials?years=5
// 接口所需积分：income/cashflow/balancesheet ≥ 120 分；fina_indicator ≥ 2000 分
app.get('/api/stock/:ticker/financials', async (req, res) => {
  const tsCode = normalizeCode(req.params.ticker);
  const years = parseInt(req.query.years || '5');

  // 财务报告期范围：从 (years+1) 年前到今年年末
  const endYear  = new Date().getFullYear();
  const startPeriod = `${endYear - years}0101`;
  const endPeriod   = `${endYear}1231`;

  try {
    // 并行拉取：利润表、现金流量表、资产负债表、财务指标、公司基本信息
    const [incData, cfData, bsData, fiData, profileData, dailyBData] = await Promise.all([
      // 利润表（合并报表 report_type=1）
      tushare('income', { ts_code: tsCode, start_date: startPeriod, end_date: endPeriod, report_type: '1' },
        'ts_code,end_date,report_type,total_revenue,revenue,operate_profit,ebit,ebitda,n_income_attr_p,income_tax,fin_exp,int_exp,basic_eps,diluted_eps'),

      // 现金流量表
      tushare('cashflow', { ts_code: tsCode, start_date: startPeriod, end_date: endPeriod, report_type: '1' },
        'ts_code,end_date,report_type,n_cashflow_act,free_cashflow,c_pay_acq_const_fixa,depr_fa_coga_dpba,amort_intang_assets,lt_amort_deferred_exp,stot_cash_out_invest'),

      // 资产负债表
      tushare('balancesheet', { ts_code: tsCode, start_date: startPeriod, end_date: endPeriod, report_type: '1' },
        'ts_code,end_date,report_type,total_assets,total_liab,total_hldr_eqy_exc_min_int,money_cap,st_borr,lt_borr,bond_payable,total_cur_assets,total_cur_liab,total_nca,total_ncl'),

      // 财务指标（综合摘要，含 FCFF、ROIC、ROE 等）
      tushare('fina_indicator', { ts_code: tsCode, start_date: startPeriod, end_date: endPeriod },
        'ts_code,end_date,eps,bps,roe,roa,roic,grossprofit_margin,netprofit_margin,fcff,fcfe,ebit,ebitda,netdebt,debt_to_assets,current_ratio,ocfps,cfps,ebit_ps,fcff_ps,assets_turn,inv_turn,ar_turn'),

      // 公司基本信息（用于 WACC 参考）
      tushare('stock_basic', { ts_code: tsCode, list_status: 'L' },
        'ts_code,name,industry,market'),

      // 最新每日基本指标（市值等）
      tushare('daily_basic', { ts_code: tsCode, ...periodToDates('5d') },
        'ts_code,trade_date,total_mv,circ_mv,pe_ttm,pb,float_share,total_share'),
    ]);

    // 转为对象数组，只保留年报（end_date 结尾为 1231）且 report_type='1'
    function annualOnly(arr) {
      return arr
        .filter(r => r.end_date?.endsWith('1231') && r.report_type === '1')
        .sort((a, b) => b.end_date.localeCompare(a.end_date)) // 最新在前
        .slice(0, years);
    }

    const incArr = annualOnly(toObjs(incData));
    const cfArr  = annualOnly(toObjs(cfData));
    const bsArr  = annualOnly(toObjs(bsData));
    const fiArr  = annualOnly(toObjs(fiData));    // fina_indicator 不含 report_type，按 end_date 过滤

    const profile  = toObjs(profileData)[0] || {};
    const latestDB = toObjs(dailyBData)[0] || {};  // 最新一条

    // ── 合并三张表 + 财务指标 ──
    const annual = incArr.map((inc, i) => {
      const cf = cfArr[i] || {};
      const bs = bsArr[i] || {};
      const fi = fiArr[i] || {};

      const revenue         = safeNum(inc.total_revenue);
      const operatingIncome = safeNum(inc.operate_profit);
      const ebit            = safeNum(inc.ebit   || fi.ebit);
      const ebitda          = safeNum(inc.ebitda || fi.ebitda);
      const netIncome       = safeNum(inc.n_income_attr_p);
      const incomeTax       = safeNum(inc.income_tax);
      const interestExp     = safeNum(inc.fin_exp || inc.int_exp); // 财务费用 or 利息支出
      const eps             = safeNum(inc.basic_eps);
      const dilutedEps      = safeNum(inc.diluted_eps);

      const operatingCF     = safeNum(cf.n_cashflow_act);
      // capex = 购建固定资产等支付现金（通常为正值，已是现金流出）
      const capex           = safeNum(cf.c_pay_acq_const_fixa);
      const fcff            = safeNum(cf.free_cashflow || fi.fcff);
      const da              = (safeNum(cf.depr_fa_coga_dpba) || 0)
                            + (safeNum(cf.amort_intang_assets) || 0)
                            + (safeNum(cf.lt_amort_deferred_exp) || 0);
      const depreciation    = da > 0 ? da : null;

      const totalAssets     = safeNum(bs.total_assets);
      const totalLiab       = safeNum(bs.total_liab);
      const equity          = safeNum(bs.total_hldr_eqy_exc_min_int);
      const cash            = safeNum(bs.money_cap);
      const shortDebt       = safeNum(bs.st_borr);
      const longDebt        = safeNum(bs.lt_borr);
      const bonds           = safeNum(bs.bond_payable);
      const totalDebt       = (shortDebt || 0) + (longDebt || 0) + (bonds || 0) || null;
      const netDebt         = totalDebt !== null && cash !== null ? totalDebt - cash : safeNum(fi.netdebt);
      const curAssets       = safeNum(bs.total_cur_assets);
      const curLiab         = safeNum(bs.total_cur_liab);

      // 比率
      const taxRate         = ebit && incomeTax && ebit > 0 ? incomeTax / ebit * 100 : null;
      const grossMargin     = safeNum(fi.grossprofit_margin);
      const netMargin       = safeNum(fi.netprofit_margin);
      const operatingMargin = revenue && operatingIncome ? operatingIncome / revenue * 100 : null;
      const ebitdaMargin    = revenue && ebitda ? ebitda / revenue * 100 : null;
      const fcfMargin       = revenue && fcff ? fcff / revenue * 100 : null;
      const fcfConversion   = netIncome && fcff && netIncome !== 0 ? fcff / netIncome * 100 : null;
      const roe             = safeNum(fi.roe);
      const roa             = safeNum(fi.roa);
      const roic            = safeNum(fi.roic);
      const debtToAssets    = safeNum(fi.debt_to_assets);
      const currentRatio    = safeNum(fi.current_ratio);

      const nopat         = ebit && taxRate !== null ? ebit * (1 - taxRate / 100) : null;
      const investedCapital = totalAssets && cash !== null ? totalAssets - cash : null;

      return {
        endDate: inc.end_date,
        // 利润表
        revenue, operatingIncome, ebit, ebitda, netIncome, eps, dilutedEps,
        incomeTax, interestExp, taxRate,
        // 现金流量表
        depreciation, operatingCF, capex, fcff,
        // 资产负债表
        totalAssets, totalLiab, equity, cash,
        shortDebt, longDebt, bonds, totalDebt, netDebt,
        curAssets, curLiab,
        // 比率
        grossMargin, operatingMargin, ebitdaMargin, netMargin, fcfMargin,
        fcfConversion, roe, roa, roic, debtToAssets, currentRatio,
        nopat, investedCapital,
        // 每股指标
        bps: safeNum(fi.bps),
        ocfps: safeNum(fi.ocfps),
        fcffPs: safeNum(fi.fcff_ps),
        ebitPs: safeNum(fi.ebit_ps),
        // 周转率
        assetsTurn: safeNum(fi.assets_turn),
        arTurn: safeNum(fi.ar_turn),
        invTurn: safeNum(fi.inv_turn),
      };
    });

    // 同比增速
    for (let i = 0; i < annual.length - 1; i++) {
      const curr = annual[i], prev = annual[i + 1];
      curr.revenueGrowthYoY = prev.revenue && curr.revenue
        ? (curr.revenue - prev.revenue) / Math.abs(prev.revenue) * 100 : null;
      curr.netIncomeGrowthYoY = prev.netIncome && curr.netIncome
        ? (curr.netIncome - prev.netIncome) / Math.abs(prev.netIncome) * 100 : null;
      curr.fcffGrowthYoY = prev.fcff && curr.fcff
        ? (curr.fcff - prev.fcff) / Math.abs(prev.fcff) * 100 : null;
      curr.ebitdaGrowthYoY = prev.ebitda && curr.ebitda
        ? (curr.ebitda - prev.ebitda) / Math.abs(prev.ebitda) * 100 : null;
    }

    // ── WACC 估算参考（A股参数）──
    const latest       = annual[0] || {};
    const totalMv      = safeNum(latestDB.total_mv);       // 总市值（万元）
    const marketCap    = totalMv ? totalMv * 1e4 : null;   // 转为元
    const totalDebtNow = latest.totalDebt;
    const taxRateRef   = safeNum(latest.taxRate) || 25;    // 中国企业所得税一般25%

    // A 股 WACC 参考参数（2024）
    const riskFreeRate = 2.5;  // 10年期国债收益率（%）
    const erp          = 7.5;  // A 股市场风险溢价（%）
    // Beta：此处用行业平均近似，用户可在前端调整
    const betaRef      = 1.0;
    const costOfEquity = +(riskFreeRate + betaRef * erp).toFixed(2);

    const debtWeight   = marketCap && totalDebtNow && totalDebtNow > 0
      ? +(totalDebtNow / (marketCap + totalDebtNow) * 100).toFixed(1) : 0;
    const equityWeight = +(100 - debtWeight).toFixed(1);

    const interestRef      = latest.interestExp;
    const costOfDebtPre    = interestRef && totalDebtNow && totalDebtNow > 0
      ? Math.abs(interestRef) / totalDebtNow * 100 : null;
    const costOfDebtAfterTax = costOfDebtPre
      ? +(costOfDebtPre * (1 - taxRateRef / 100)).toFixed(2) : null;

    const waccEstimate = costOfDebtAfterTax
      ? +((equityWeight / 100) * costOfEquity + (debtWeight / 100) * costOfDebtAfterTax).toFixed(2)
      : null;

    res.json({
      tsCode,
      name: profile.name || tsCode,
      industry: profile.industry || null,
      // WACC 估算参考
      waccRef: {
        note: 'WACC = E/(E+D)×Ke + D/(E+D)×Kd×(1-T)，仅供参考，建议结合行业Beta调整',
        riskFreeRate,
        erp,
        betaRef,
        taxRate: taxRateRef,
        costOfEquity,
        costOfDebtPreTax: costOfDebtPre ? +costOfDebtPre.toFixed(2) : null,
        costOfDebtAfterTax,
        equityWeight,
        debtWeight,
        waccEstimate,
      },
      // 年度历史财务（最新在前，最多 years 年）
      annual,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 健康检查 ────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── 启动 ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  DCF 分析后端已启动：http://localhost:${PORT}`);
  console.log('');
  console.log('API 接口：');
  console.log(`  GET /api/stock/:ticker                  基本信息（支持 600519 / 600519.SH）`);
  console.log(`  GET /api/stock/:ticker/history          K线  ?period=1y&interval=1d|1w|1mo`);
  console.log(`  GET /api/stock/:ticker/indicators       技术指标  ?period=1y`);
  console.log(`  GET /api/stock/:ticker/financials       DCF财务数据  ?years=5`);
  console.log('');
  console.log('数据源：Tushare Pro（HTTP POST）');
  console.log(`Token：${TOKEN ? '****' + TOKEN.slice(-4) : '未设置（见 .env.example）'}`);
  console.log('');
});
