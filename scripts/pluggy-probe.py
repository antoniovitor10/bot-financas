import os, json, urllib.request, urllib.error
for l in open('.env',encoding='utf-8'):
    l=l.strip()
    if l and not l.startswith('#') and '=' in l:
        k,v=l.split('=',1); os.environ.setdefault(k.strip(),v.strip())
def req(url, data=None, key=None):
    h={'Content-Type':'application/json'}
    if key: h['X-API-KEY']=key
    r=urllib.request.Request(url, data=json.dumps(data).encode() if data else None, headers=h, method='POST' if data else 'GET')
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.load(resp)
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
s,a=req('https://api.pluggy.ai/auth',{'clientId':os.environ['PLUGGY_CLIENT_ID'],'clientSecret':os.environ['PLUGGY_CLIENT_SECRET']}); k=a['apiKey']
iid=os.environ['PLUGGY_ITEMS'].split(',')[-1].split('=')[0]
s,accs=req(f'https://api.pluggy.ai/accounts?itemId={iid}',key=k); print('accounts',s, len(accs['results']) if s==200 else accs)
acc=accs['results'][0]['id']
for u in [f'https://api.pluggy.ai/transactions?accountId={acc}&from=2026-10-01&pageSize=3', f'https://api.pluggy.ai/v2/transactions?accountId={acc}&from=2026-10-01&pageSize=3', f'https://api.pluggy.ai/transactions?accountId={acc}&pageSize=3']:
    s,t=req(u,key=k); print(u.split('.ai')[1][:40], s, (t if s!=200 else [ (x['date'][:10],x['amount'],x.get('category')) for x in t['results'][:3]]))
print('---v2')
s,t=req(f'https://api.pluggy.ai/v2/transactions?accountId={acc}',key=k)
print(s, list(t.keys()) if s==200 else t)
if s==200:
    for x in t['results'][:3]: print(x['date'][:10], x['amount'], (x.get('description') or '')[:30], '|', x.get('category'), '|', x.get('type'))
    print('keys:', sorted(t['results'][0].keys()) if t['results'] else None, 'next:', bool(t.get('next') or t.get('nextCursor')))
