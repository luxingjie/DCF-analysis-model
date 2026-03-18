"""
DCF 分析后端 - Flask + Tushare（行情）+ AKShare（财报）
运行方式: venv/bin/python app.py
"""
import os, time, traceback
from datetime import datetime, timedelta
from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS
import tushare as ts
import akshare as ak
import pandas as pd
import numpy as np

load_dotenv()

app = Flask(__name__)
CORS(app)  # 允许 file:// 和 localhost 跨域

TOKEN = os.getenv('TUSHARE_TOKEN')
ts.set_token(TOKEN)
pro = ts.pro_api()

PORT = 5001

# ─── 工具函数 ──────────────────────────────────────────────────────────────────

def safe(v):
    """安全转浮点，NaN/None → None"""
    try:
        f = float(v)
        return None if (f != f) else f  # NaN check
    except Exception:
        return None

def norm_ts(raw):
    """600519 / 600519.SH → 600519.SH"""
    s = str(raw).strip().upper()
    if '.' in s:
        return s
    if s.startswith('6') or s.startswith('9'):
        return f'{s}.SH'
    if s.startswith('0') or s.startswith('3'):
        return f'{s}.SZ'
    if s.startswith('8') or s.startswith('4'):
        return f'{s}.BJ'
    return s

def norm_6(raw):
    """600519.SH → 600519"""
    return str(raw).strip().upper().split('.')[0]

def date_range(period='1y'):
    days = {'1d':5,'5d':10,'1mo':40,'3mo':100,'6mo':200,
            '1y':380,'2y':750,'5y':1850,'10y':3700}
    end = datetime.now()
    start = end - timedelta(days=days.get(period, 380))
    return start.strftime('%Y%m%d'), end.strftime('%Y%m%d')

# 简单内存缓存（避免频率限制）
_cache = {}
def cached(key, fn, ttl=3600):
    now = time.time()
    if key in _cache and now - _cache[key]['t'] < ttl:
        return _cache[key]['v']
    v = fn()
    _cache[key] = {'v': v, 't': now}
    return v

# 技术指标计算（纯 pandas）
def calc_indicators(df):
    c = df['close'].astype(float)
    h = df['high'].astype(float)
    l = df['low'].astype(float)

    result = df[['trade_date','open','high','low','close','vol']].copy()
    result['ma5']   = c.rolling(5).mean()
    result['ma10']  = c.rolling(10).mean()
    result['ma20']  = c.rolling(20).mean()
    result['ma60']  = c.rolling(60).mean()
    result['ema12'] = c.ewm(span=12, adjust=False).mean()
    result['ema26'] = c.ewm(span=26, adjust=False).mean()

    # RSI(14)
    delta = c.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    result['rsi'] = 100 - (100 / (1 + gain / loss.replace(0, np.nan)))

    # MACD(12,26,9)
    macd_line   = result['ema12'] - result['ema26']
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    result['macd']      = macd_line
    result['macd_sig']  = signal_line
    result['macd_hist'] = macd_line - signal_line

    # Bollinger Bands(20, 2σ)
    bb_mid = c.rolling(20).mean()
    bb_std = c.rolling(20).std()
    result['bb_upper'] = bb_mid + 2 * bb_std
    result['bb_mid']   = bb_mid
    result['bb_lower'] = bb_mid - 2 * bb_std

    # ATR(14)
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    result['atr'] = tr.rolling(14).mean()

    return result

# ─── 1. 股票基本信息 ──────────────────────────────────────────────────────────
@app.route('/api/stock/<code>')
def stock_info(code):
    ts_code = norm_ts(code)
    sym     = norm_6(code)
    try:
        # 最近行情（Tushare daily，取最新一条）
        sd, ed = date_range('5d')
        daily_df = pro.daily(ts_code=ts_code, start_date=sd, end_date=ed,
                             fields='ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount')
        if daily_df.empty:
            return jsonify({'error': f'未找到股票 {code}，请检查代码是否正确'}), 404

        row = daily_df.iloc[0]  # 最新一条（降序）

        # 股票基本信息（1次/小时限速，失败时使用缓存或空值）
        try:
            basic_df = cached(f'basic_{ts_code}',
                              lambda: pro.stock_basic(ts_code=ts_code,
                                                       fields='ts_code,symbol,name,industry,area,market,list_date'),
                              ttl=3600)
            basic = basic_df.iloc[0].to_dict() if not basic_df.empty else {}
        except Exception:
            basic = _cache.get(f'basic_{ts_code}', {}).get('v', pd.DataFrame())
            basic = basic.iloc[0].to_dict() if hasattr(basic, 'iloc') and not basic.empty else {}

        # AKShare 个股详情（PE、PB、市值等）
        try:
            info_df = ak.stock_individual_info_em(symbol=sym)
            info = dict(zip(info_df.iloc[:, 0], info_df.iloc[:, 1]))
        except Exception:
            info = {}

        def g(k): return safe(info.get(k))

        return jsonify({
            'code': sym,
            'tsCode': ts_code,
            'name': basic.get('name', sym),
            'industry': basic.get('industry'),
            'area': basic.get('area'),
            'market': basic.get('market'),
            'listDate': basic.get('list_date'),
            # 最新行情
            'tradeDate': row['trade_date'],
            'price':     safe(row['close']),
            'preClose':  safe(row['pre_close']),
            'open':      safe(row['open']),
            'high':      safe(row['high']),
            'low':       safe(row['low']),
            'change':    safe(row['change']),
            'changePct': safe(row['pct_chg']),
            'volume':    safe(row['vol']),    # 手
            'amount':    safe(row['amount']), # 千元
            # 估值（AKShare）
            'totalMv':   g('总市值'),   # 元
            'circMv':    g('流通市值'),
            'pe':        g('市盈率-动态'),
            'pb':        g('市净率'),
            'eps':       g('每股收益'),
            'totalShare':g('总股本'),
            'floatShare':g('流通股'),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# ─── 2. K 线历史 ──────────────────────────────────────────────────────────────
@app.route('/api/stock/<code>/history')
def stock_history(code):
    from flask import request
    ts_code = norm_ts(code)
    period   = request.args.get('period', '1y')
    interval = request.args.get('interval', '1d')
    try:
        sd, ed = date_range(period)
        api_map = {'1w': pro.weekly, '1mo': pro.monthly}
        fetch   = api_map.get(interval, pro.daily)
        df = fetch(ts_code=ts_code, start_date=sd, end_date=ed,
                   fields='trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount')
        df = df.iloc[::-1]  # 升序

        candles = [{
            'date':      r['trade_date'],
            'open':      safe(r['open']),
            'high':      safe(r['high']),
            'low':       safe(r['low']),
            'close':     safe(r['close']),
            'preClose':  safe(r['pre_close']),
            'change':    safe(r['change']),
            'changePct': safe(r['pct_chg']),
            'volume':    safe(r['vol']),
            'amount':    safe(r['amount']),
        } for _, r in df.iterrows()]

        return jsonify({'code': norm_6(code), 'period': period, 'interval': interval,
                        'count': len(candles), 'candles': candles})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── 3. 技术指标 ─────────────────────────────────────────��────────────────────
@app.route('/api/stock/<code>/indicators')
def stock_indicators(code):
    from flask import request
    ts_code = norm_ts(code)
    period  = request.args.get('period', '1y')
    try:
        sd, ed = date_range(period)
        df = pro.daily(ts_code=ts_code, start_date=sd, end_date=ed,
                       fields='trade_date,open,high,low,close,vol')
        df = df.iloc[::-1].reset_index(drop=True)  # 升序
        result = calc_indicators(df)

        def row_to_dict(r):
            return {k: (None if pd.isna(v) else float(v)) if k != 'trade_date' else v
                    for k, v in r.items()}

        return jsonify({'code': norm_6(code), 'period': period,
                        'count': len(result),
                        'indicators': result.apply(row_to_dict, axis=1).tolist()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── 4. DCF 财报数据 ──────────────────────────────────────────────────────────
@app.route('/api/stock/<code>/financials')
def stock_financials(code):
    from flask import request
    sym   = norm_6(code)
    years = int(request.args.get('years', 5))
    try:
        errors = []

        # ── 利润表 ──
        try:
            inc_df = ak.stock_profit_sheet_by_report_em(symbol=sym)
        except Exception as e:
            inc_df = pd.DataFrame()
            errors.append(f'利润表: {e}')

        # ── 现金流量表 ──
        try:
            cf_df = ak.stock_cash_flow_sheet_by_report_em(symbol=sym)
        except Exception as e:
            cf_df = pd.DataFrame()
            errors.append(f'现金流: {e}')

        # ── 资产负债表 ──
        try:
            bs_df = ak.stock_balance_sheet_by_report_em(symbol=sym)
        except Exception as e:
            bs_df = pd.DataFrame()
            errors.append(f'资产负债: {e}')

        # AKShare 东方财富报表列格式：第一列为指标名，后续列为各报告期
        # 转置：行=报告期，列=指标
        def pivot_em(df):
            if df.empty:
                return pd.DataFrame()
            df = df.copy()
            df.columns = df.columns.astype(str)
            # 第一列是指标名
            idx_col = df.columns[0]
            df = df.set_index(idx_col).T
            df.index.name = 'end_date'
            df.index = df.index.str.replace('-', '').str[:8]  # YYYYMMDD
            return df

        inc  = pivot_em(inc_df)
        cf   = pivot_em(cf_df)
        bs   = pivot_em(bs_df)

        # 只保留年报（1231 结尾）
        def annual_only(df):
            if df.empty:
                return df
            mask = df.index.str.endswith('1231')
            return df[mask].sort_index(ascending=False).head(years)

        inc = annual_only(inc)
        cf  = annual_only(cf)
        bs  = annual_only(bs)

        # 合并年度数据
        all_dates = sorted(
            set(inc.index.tolist() + cf.index.tolist() + bs.index.tolist()),
            reverse=True
        )[:years]

        annual = []
        for date in all_dates:
            i  = inc.loc[date]  if date in inc.index  else pd.Series(dtype=float)
            c  = cf.loc[date]   if date in cf.index   else pd.Series(dtype=float)
            b  = bs.loc[date]   if date in bs.index   else pd.Series(dtype=float)

            def gi(*keys):
                for k in keys:
                    v = safe(i.get(k)) if hasattr(i, 'get') else None
                    if v is not None: return v
                return None
            def gc(*keys):
                for k in keys:
                    v = safe(c.get(k)) if hasattr(c, 'get') else None
                    if v is not None: return v
                return None
            def gb(*keys):
                for k in keys:
                    v = safe(b.get(k)) if hasattr(b, 'get') else None
                    if v is not None: return v
                return None

            # 利润表字段（单位：元）
            revenue    = gi('营业总收入', '营业收入')
            op_income  = gi('营业利润')
            net_income = gi('归属于母公司所有者的净利润', '净利润')
            income_tax = gi('所得税费用')
            fin_exp    = gi('财务费用')
            ebit       = gi('息税前利润')

            # 现金流字段（单位：元）
            op_cf   = gc('经营活动产生的现金流量净额')
            capex   = gc('购建固定资产、无形资产和其他长期资产支付的现金')
            da      = gc('固定资产折旧、油气资产折耗、生产性生物资产折旧',
                         '折旧与摊销')
            fcf     = gc('企业自由现金流量')
            # 若无直接 FCF，用 经营CF - CapEx 估算
            if fcf is None and op_cf is not None and capex is not None:
                fcf = op_cf - capex

            # 资产负债表字段（单位：元）
            total_assets = gb('资产总计', '资产合计')
            total_liab   = gb('负债合计')
            equity       = gb('归属于母公司所有者权益合计', '股东权益合计')
            cash         = gb('货币资金')
            st_debt      = gb('短期借款')
            lt_debt      = gb('长期借款')
            bonds        = gb('应付债券')
            total_debt   = ((st_debt or 0) + (lt_debt or 0) + (bonds or 0)) or None
            net_debt     = (total_debt - cash) if (total_debt and cash) else None
            cur_assets   = gb('流动资产合计')
            cur_liab     = gb('流动负债合计')

            # 派生比率
            tax_rate      = (income_tax / ebit * 100) if ebit and income_tax and ebit > 0 else None
            op_margin     = (op_income / revenue * 100) if op_income and revenue else None
            net_margin    = (net_income / revenue * 100) if net_income and revenue else None
            fcf_margin    = (fcf / revenue * 100) if fcf and revenue else None
            fcf_conv      = (fcf / net_income * 100) if fcf and net_income and net_income != 0 else None
            roe           = (net_income / equity * 100) if net_income and equity and equity != 0 else None
            roa           = (net_income / total_assets * 100) if net_income and total_assets else None

            annual.append({
                'endDate': date,
                'revenue': revenue, 'operatingIncome': op_income,
                'netIncome': net_income, 'incomeTax': income_tax,
                'financialExp': fin_exp, 'ebit': ebit,
                'depreciation': da, 'operatingCF': op_cf,
                'capex': capex, 'fcf': fcf,
                'totalAssets': total_assets, 'totalLiab': total_liab,
                'equity': equity, 'cash': cash,
                'shortDebt': st_debt, 'longDebt': lt_debt,
                'totalDebt': total_debt, 'netDebt': net_debt,
                'curAssets': cur_assets, 'curLiab': cur_liab,
                'taxRate': tax_rate, 'opMargin': op_margin,
                'netMargin': net_margin, 'fcfMargin': fcf_margin,
                'fcfConversion': fcf_conv, 'roe': roe, 'roa': roa,
            })

        # 同比增速
        for i in range(len(annual) - 1):
            curr, prev = annual[i], annual[i + 1]
            def yoy(curr_v, prev_v):
                if curr_v and prev_v and prev_v != 0:
                    return (curr_v - prev_v) / abs(prev_v) * 100
                return None
            curr['revenueGrowth']   = yoy(curr['revenue'],   prev['revenue'])
            curr['netIncomeGrowth'] = yoy(curr['netIncome'], prev['netIncome'])
            curr['fcfGrowth']       = yoy(curr['fcf'],       prev['fcf'])

        # ── WACC 估算（A股参数）──
        latest = annual[0] if annual else {}
        try:
            info_df = ak.stock_individual_info_em(symbol=sym)
            info    = dict(zip(info_df.iloc[:, 0], info_df.iloc[:, 1]))
            mv_val  = safe(info.get('总市值'))
        except Exception:
            mv_val = None

        risk_free  = 2.5   # 10Y 国债收益率 %
        erp        = 7.5   # A 股市场风险溢价 %
        beta_ref   = 1.0   # 行业平均 beta 参考
        tax_r      = latest.get('taxRate') or 25.0

        cost_of_eq = round(risk_free + beta_ref * erp, 2)
        td         = latest.get('totalDebt')
        d_weight   = round(td / (mv_val + td) * 100, 1) if (mv_val and td) else 0.0
        e_weight   = round(100 - d_weight, 1)
        fin_e      = latest.get('financialExp')
        kd_pre     = round(abs(fin_e) / td * 100, 2) if (fin_e and td and td > 0) else None
        kd_post    = round(kd_pre * (1 - tax_r / 100), 2) if kd_pre else None
        wacc_est   = round(e_weight / 100 * cost_of_eq + d_weight / 100 * (kd_post or 0), 2) if kd_post else None

        return jsonify({
            'code': sym, 'name': '',
            'waccRef': {
                'riskFreeRate': risk_free, 'erp': erp, 'betaRef': beta_ref,
                'taxRate': tax_r, 'costOfEquity': cost_of_eq,
                'costOfDebtPreTax': kd_pre, 'costOfDebtAfterTax': kd_post,
                'equityWeight': e_weight, 'debtWeight': d_weight,
                'waccEstimate': wacc_est,
                'note': 'WACC仅供参考，建议结合行业Beta调整。A股无风险利率取10年期国债'
            },
            'annual': annual,
            'errors': errors,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# ─── 健康检查 ──────────────────────────────────────────────────────────────────
@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'time': datetime.now().isoformat()})

if __name__ == '__main__':
    print(f'\n✅  DCF A股后端已启动：http://localhost:{PORT}')
    print(f'Token：****{TOKEN[-4:] if TOKEN else "未设置"}')
    print(f'\n接口：')
    print(f'  GET /api/stock/<code>             基本信息（如 600519）')
    print(f'  GET /api/stock/<code>/history     K线  ?period=1y&interval=1d')
    print(f'  GET /api/stock/<code>/indicators  技术指标')
    print(f'  GET /api/stock/<code>/financials  DCF财报数据\n')
    app.run(host='0.0.0.0', port=PORT, debug=False)
