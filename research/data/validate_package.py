"""Validate research imports and provenance. Requires jsonschema and shapely."""
from pathlib import Path
import json, csv, re, hashlib
from decimal import Decimal
from datetime import datetime, timedelta
from jsonschema import Draft202012Validator
from shapely.geometry import shape
from shapely.validation import explain_validity

ROOT=Path(__file__).resolve().parent
errors=[]; warnings=[]; details={}
def require(ok,message):
    if not ok:errors.append(message)
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def serialized(v):return 'null' if v is None else str(v).lower() if isinstance(v,bool) else str(v)

for folder in sorted(ROOT.glob('DR-*')):
    dr=folder.name
    for required in ['README.txt','sources.csv','data.csv','schema.json','quality.json','expert_questions.txt','sample.json','records.json']:
        require((folder/required).is_file(),f'{dr}: missing {required}')
    records=read(folder/'records.json');schema=read(folder/'schema.json')
    Draft202012Validator.check_schema(schema)
    errors += [f'{dr}: schema {list(e.path)}: {e.message}' for e in Draft202012Validator(schema).iter_errors(records)]
    source_ids={r['source_id'] for r in records['sources.csv']}
    require(len(source_ids)==len(records['sources.csv']),f'{dr}: duplicate source ids')
    count=0
    for file,rows in records.items():
        csvrows=list(csv.DictReader((folder/file).open(encoding='utf-8',newline='')))
        require(len(rows)==len(csvrows),f'{dr}/{file}: CSV row count')
        for i,(r,c) in enumerate(zip(rows,csvrows)):
            require({k:serialized(v) for k,v in r.items()}==c,f'{dr}/{file}:{i}: CSV/JSON mismatch')
            for key in ['source_id','source_refs']:
                if r.get(key):
                    for sid in r[key].split(';'):
                        require(sid in source_ids,f'{dr}/{file}:{i}: unknown source {sid}')
            if file!='sources.csv':
                count+=1
                for key in ['amount','price']:
                    if key in r and r[key] is not None:
                        require(isinstance(r[key],str) and bool(re.fullmatch(r'\d+\.\d{2}',r[key])),f'{dr}/{file}: money format')
                        require(Decimal(r[key])>=0,f'{dr}/{file}: negative money')
                        require(r.get('currency')=='KZT',f'{dr}/{file}: currency')
                if file in ['rules.csv','traits.csv']:
                    numeric=any(isinstance(r.get(k),(int,float)) and not isinstance(r.get(k),bool) for k in ['value','lower','upper'])
                    if numeric:require(bool(r.get('source_id') and r.get('unit') and r.get('applicability')),f'{dr}/{file}:{i}: numeric provenance/unit/conditions')
        if rows:
            key=next(iter(rows[0]))
            if key.endswith('_id') and file!='sources.csv':
                require(len({r[key] for r in rows})==len(rows),f'{dr}/{file}: duplicate primary key {key}')
    geometry={}
    for f in folder.glob('*.geojson'):
        gj=read(f);gs=read(folder/'geojson.schema.json');Draft202012Validator.check_schema(gs)
        errors += [f'{dr}/{f.name}: {e.message}' for e in Draft202012Validator(gs).iter_errors(gj)]
        invalid=[]; bounds=[]; ids=[]
        for index,feature in enumerate(gj['features']):
            geom=shape(feature['geometry']);bounds.append(geom.bounds)
            require(not geom.is_empty,f'{dr}/{f.name}: empty feature{index}')
            x1,y1,x2,y2=geom.bounds
            require(-180<=x1<=x2<=180 and -90<=y1<=y2<=90,f'{dr}/{f.name}: invalid CRS extent')
            require(76<x1<78 and 51<y1<54,f'{dr}/{f.name}: outside Pavlodar working vicinity')
            if not geom.is_valid:invalid.append(dict(index=index,reason=explain_validity(geom)))
            p=feature.get('properties',{})
            if 'object_id' in p:ids.append(p['object_id'])
            if f.name=='buildings.geojson':
                require(p.get('height_basis')=='recorded_unverified',f'{dr}: synthetic height slipped in')
                require(p.get('source_id') in source_ids and p.get('height_m',0)>0,f'{dr}: height provenance')
        require(len(ids)==len(set(ids)),f'{dr}/{f.name}: duplicate object id')
        geometry[f.name]=dict(feature_count=len(gj['features']),invalid_features=invalid,topology_repaired=False)
        if invalid:warnings.append(f'{dr}/{f.name}: {len(invalid)} invalid geometries, do not use for spatial operations without review')
    details[dr]=dict(tables=len(records),non_source_rows=count,geometry=geometry)
    q=read(folder/'quality.json');require(q['acceptance_met'] is False,f'{dr}: gate incorrectly passed')
    q['geometry_validation']=geometry
    (folder/'quality.json').write_text(json.dumps(q,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

data=read(ROOT/'DR-02/records.json');taxa={p['taxon_id'] for p in data['plants.csv']}
for r in data['traits.csv']+data['stock.csv']:require(r['taxon_id'] in taxa,'DR-02: taxon FK')
require(data['stock.csv']==read(ROOT/'DR-05/records.json')['stock.csv'],'stock mirrors differ')
require(all(p['expert_approved'] is False for p in data['plants.csv']),'unearned expert approval')
data=read(ROOT/'DR-04/records.json')
for file in ['cohorts.csv','observations.csv','care_actual.csv']:require(data[file]==[],'DR-04 fabricated rows')
require(all(r['training_eligible'] is False for r in data['reported_events.csv']),'press report training eligibility')
w=read(ROOT/'DR-06/records.json')['weather.csv'];times=[datetime.fromisoformat(r['time_utc']) for r in w]
require(len(times)==168 and all(y-x==timedelta(hours=1) for x,y in zip(times,times[1:])),'weather temporal coverage')
require(all(r['method']=='reanalysis' for r in w),'weather method')
raw=read(ROOT/'DR-06/weather_raw.json')
for i,r in enumerate(w):
    require(all(r[k]==v[i] for k,v in raw['hourly'].items() if k!='time'),f'weather raw mismatch{i}')
require(all(r['value'] is None for r in read(ROOT/'DR-06/records.json')['coefficients.csv']),'fabricated local coefficient')
plan=read(ROOT.parents[1]/'planning/data_requests.json')
require(plan['organizer_data_received'] is False,'organizer flag changed')
for r in plan['requests']:
    require(r['status'] in ['found','partial','not_found'],'unresolved status')
    require(r['acceptance_met'] is False,'acceptance incorrectly passed')
    for f in r['research_evidence']:require((ROOT.parents[1]/f).is_file(),f'missing evidence {f}')
report=dict(checked_at='2026-10-29',status='passed' if not errors else 'failed',checks=['JSON Schema 2020-12','CSV/typed JSON equivalence','source/taxon/stock foreign keys','money decimal KZT','numeric trait/rule units and applicability','GeoJSON extent, duplicates and Shapely validity','UTC hourly continuity and raw weather equivalence','no synthetic heights or fabricated survival/coefficients','planning evidence paths and blocked acceptance gates'],errors=errors,warnings=warnings,packages=details,scope='Structural/provenance validation; not field truth, legal approval or model calibration')
(ROOT/'validation_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(bool(errors))
