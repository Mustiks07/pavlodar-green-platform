"""Check normative schemas, fixtures and task dependencies, not product implementation."""
import ast,json,re,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
from jsonschema import Draft202012Validator,FormatChecker
from openapi_spec_validator import validate
def read(p):return json.loads((ROOT/p).read_text(encoding='utf-8'))
domain=read('contracts/domain.schema.json');api=read('contracts/openapi.json');Draft202012Validator.check_schema(domain);validate(api)
checks=[]
def ok(name,condition):
 if not condition:raise AssertionError(name)
 checks.append(name)
ok('OpenAPI and domain definitions match',api['components']['schemas']==json.loads(json.dumps(domain['$defs']).replace('#/$defs/','#/components/schemas/')))
def walk(o):
 if isinstance(o,dict):
  if '$ref' in o:
   value=o['$ref'];ok('resolve '+value,value.startswith('#/$defs/') and value.split('/')[-1] in domain['$defs'])
  for v in o.values():walk(v)
 elif isinstance(o,list):
  for v in o:walk(v)
walk(domain)
fixture_count=0
for path in sorted((ROOT/'contracts/fixtures').glob('*.json')):
 f=json.loads(path.read_text(encoding='utf-8'));schema={'$schema':domain['$schema'],'$defs':domain['$defs'],'$ref':'#/$defs/'+f['schema']}
 errors=list(Draft202012Validator(schema,format_checker=FormatChecker()).iter_errors(f['data']))
 ok('fixture '+path.name,(not errors)==f['expected_valid']);fixture_count+=1
ops=[]
for path,methods in api['paths'].items():
 for method,operation in methods.items():
  if method not in ['get','post','put','patch','delete','head']:continue
  ops.append(operation['operationId']);params=operation.get('parameters',[])
  for name in re.findall(r'{([^}]+)}',path):ok('path param '+name,any(p['name']==name and p['in']=='path' and p.get('required') for p in params))
  if method not in ['get','head']:
   ok('write csrf '+path,any(p['name']=='X-CSRF-Token' and p.get('required') for p in params))
   ok('write idempotency '+path,any(p['name']=='Idempotency-Key' and p.get('required') for p in params))
ok('unique operation IDs',len(ops)==len(set(ops)))
ok('operation inventory matches',set(ops)=={x['operation_id'] for x in read('contracts/operations.json')})
units=read('contracts/units.json');metrics=read('contracts/metric_keys.json');problems=read('contracts/problem_codes.json')
ok('unit registry version',units['version']==api['info']['version'])
unit_keys=[x['key'] for x in units['units']]
ok('unit keys unique',len(unit_keys)==len(set(unit_keys)))
metric_keys=[x['key'] for x in metrics['metrics']]
ok('metric registry version',metrics['version']==api['info']['version'])
ok('metric keys unique',len(metric_keys)==len(set(metric_keys)))
ok('metric units registered',all(x['unit'] in unit_keys for x in metrics['metrics']))
cost_fixture_units=[]
for fixture_path in sorted((ROOT/'contracts/fixtures').glob('*.json')):
 fixture=read(fixture_path.relative_to(ROOT))
 if fixture['schema']=='CostResult':cost_fixture_units.extend(x['unit'] for x in fixture['data']['lines'])
ok('cost fixture units registered',set(cost_fixture_units)<=set(unit_keys))
problem_codes=[x['code'] for x in problems['codes']]
ok('problem registry version',problems['version']==api['info']['version'])
ok('problem codes unique',len(problem_codes)==len(set(problem_codes)))
runtime_codes=set()
for source_root in ('packages','services'):
 for source_path in (ROOT/source_root).rglob('*.py'):
  tree=ast.parse(source_path.read_text(encoding='utf-8'))
  for node in ast.walk(tree):
   if not isinstance(node,ast.Call) or not isinstance(node.func,ast.Name) or node.func.id not in {'DomainError','gap'}:continue
   index=1 if node.func.id=='DomainError' else 0
   if len(node.args)>index and isinstance(node.args[index],ast.Constant) and isinstance(node.args[index].value,str):runtime_codes.add(node.args[index].value)
ok('runtime problem codes registered',runtime_codes<=set(problem_codes))
tasks=read('planning/work_packages.json')['packages'];ids={x['id'] for x in tasks};ac={x['id'] for x in read('planning/acceptance.json')['criteria']}
ok('task IDs unique',len(ids)==len(tasks));ok('acceptance references',all(set(x['acceptance_ids'])<=ac for x in tasks))
seen=set()
while len(seen)<len(ids):
 ready={x['id'] for x in tasks if set(x['depends_on'])<=seen}-seen
 ok('DAG progresses',bool(ready));seen.update(ready)
spec=(ROOT/'docs/TZ_DEVELOPMENT.txt').read_text(encoding='utf-8')
ok('all acceptance IDs in specification',all(x in spec for x in ac))
ok('all data requests in specification',all(x['id'] in spec for x in read('planning/data_requests.json')['requests']))
trace=read('planning/traceability.json')
ok('traceability acceptance references',all(set(x['acceptance_ids'])<=ac for x in trace['mapping']))
ok('traceability work package references',all(set(x['work_packages'])<=ids for x in trace['mapping']))
ok('original requirements present',(ROOT/trace['source']).is_file())
ok('recognized project lifecycle',read('coordination/STATUS.json')['status'] in ['specification_prepared_implementation_not_started','implementation_in_progress','integration_testing','platform_ready_data_gates_open','release_accepted'])
summary={'scope':'Specification integrity only; no application functionality or scientific accuracy tested','passed':True,'schema_count':len(domain['$defs']),'operation_count':len(ops),'fixture_count':fixture_count,'checks_executed':len(checks),'work_packages':len(tasks),'acceptance_criteria':len(ac)}
print(json.dumps(summary,ensure_ascii=False,indent=2))
if '--write-evidence' in sys.argv:
 p=ROOT/'docs/evidence/spec_validation.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
