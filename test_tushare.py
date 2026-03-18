import tushare as ts
import requests
import json

TOKEN = '462ae269bfd8fe77c2af6f33d25a7ef85eea42830e23732167cbd612'

print('=' * 50)
print('方式1：Python tushare 官方 SDK')
print('=' * 50)
ts.set_token(TOKEN)
pro = ts.pro_api()

try:
    df = pro.daily(ts_code='600519.SH', start_date='20250310', end_date='20250317')
    print('daily 行情：')
    print(df)
except Exception as e:
    print(f'daily 失败：{e}')

try:
    df = pro.stock_basic(ts_code='600519.SH', fields='ts_code,name,industry')
    print('\nstock_basic：')
    print(df)
except Exception as e:
    print(f'stock_basic 失败：{e}')

try:
    df = pro.income(ts_code='600519.SH', period='20231231',
                    fields='ts_code,end_date,total_revenue,n_income_attr_p,ebit')
    print('\nincome 利润表：')
    print(df)
except Exception as e:
    print(f'income 失败：{e}')

print('\n' + '=' * 50)
print('方式2：直接 HTTP POST（原始请求）')
print('=' * 50)
resp = requests.post('http://api.tushare.pro', json={
    'api_name': 'trade_cal',
    'token': TOKEN,
    'params': {'start_date': '20250315', 'end_date': '20250317'},
    'fields': 'cal_date,is_open'
}, timeout=10)
print(json.dumps(resp.json(), ensure_ascii=False, indent=2))
