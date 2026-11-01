"""Render the specification and handoff appendices. No implementation claims."""
import argparse,json,re,hashlib
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import BaseDocTemplate,PageTemplate,Frame,Paragraph,Spacer,PageBreak,Table,TableStyle,CondPageBreak,Flowable
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--font-dir',default='C:/Windows/Fonts');args=parser.parse_args()
fonts=Path(args.font_dir)
regular=next((fonts/n for n in ['arial.ttf','DejaVuSans.ttf'] if (fonts/n).exists()),None)
bold=next((fonts/n for n in ['arialbd.ttf','DejaVuSans-Bold.ttf'] if (fonts/n).exists()),None)
if not regular or not bold:raise SystemExit('Provide --font-dir containing Arial or DejaVu Sans regular and bold TTF fonts')
pdfmetrics.registerFont(TTFont('Body',str(regular)));pdfmetrics.registerFont(TTFont('Body-Bold',str(bold)));pdfmetrics.registerFontFamily('Body',normal='Body',bold='Body-Bold')
INK=colors.HexColor('#173B35');MUTED=colors.HexColor('#5F7169');PALE=colors.HexColor('#EAF2ED');BORDER=colors.HexColor('#CEDDD4')
styles={
 'body':ParagraphStyle('BodyText',fontName='Body',fontSize=10,leading=14.7,spaceAfter=9,textColor=INK,allowWidows=0,allowOrphans=0),
 'small':ParagraphStyle('Small',fontName='Body',fontSize=8,leading=11.5,spaceAfter=7,textColor=MUTED),
 'h1':ParagraphStyle('Heading1',fontName='Body-Bold',fontSize=18,leading=23,spaceBefore=14,spaceAfter=11,keepWithNext=True,textColor=INK),
 'h2':ParagraphStyle('Heading2',fontName='Body-Bold',fontSize=12,leading=16,spaceBefore=10,spaceAfter=7,keepWithNext=True,textColor=INK),
 'title':ParagraphStyle('Title',fontName='Body-Bold',fontSize=29,leading=35,spaceAfter=24,textColor=INK),
 'label':ParagraphStyle('Label',fontName='Body-Bold',fontSize=9,leading=13,spaceAfter=16,textColor=MUTED),
 'cell':ParagraphStyle('Cell',fontName='Body',fontSize=8.3,leading=11,textColor=INK),
}
def clean(s):
 for ch in '\u2010\u2011\u2012\u2013\u2014\u2212':s=s.replace(ch,'-')
 return s
def p(s,style='body',raw=False):return Paragraph(clean(s if raw else escape(s)),styles[style])
story=[]
def add(s,style='body',raw=False):story.append(p(s,style,raw))
def heading(s):story.append(CondPageBreak(140));add(s,'h1')
def table(headers,rows,widths):
 data=[[p(str(x),'cell') for x in headers]]+[[p(str(x),'cell') for x in row] for row in rows]
 t=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT');t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),PALE),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F7F9F7')]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),('LINEBELOW',(0,0),(-1,0),.5,BORDER)]));story.append(t);story.append(Spacer(1,10))
class Architecture(Flowable):
 def __init__(self):Flowable.__init__(self);self.width=491;self.height=300
 def draw(self):
  c=self.canv
  boxes=[(0,246,491,44,'React · MapLibre · Three.js','Карта / сценарии / работы / чат'),(0,174,491,47,'FastAPI / BFF / Domain','OIDC · права · версии · вычислительное ядро'),(0,90,235,53,'PostgreSQL / PostGIS','Источники · сценарии · Job / outbox'),(256,90,235,53,'Celery workers / Redis','Импорт · оптимизация · физика · экспорт'),(0,8,235,50,'Файлы и тайлы','PMTiles · COG · manifests · PDF / Excel'),(256,8,235,50,'LLM через инструменты','RAG ACL · факты · предложения правок')]
  for x,y,w,h,a,b in boxes:
   c.setFillColor(PALE);c.setStrokeColor(BORDER);c.roundRect(x,y,w,h,7,fill=1,stroke=1);c.setFillColor(INK);c.setFont('Body-Bold',10);c.drawCentredString(x+w/2,y+h-18,a);c.setFont('Body',8.4);c.drawCentredString(x+w/2,y+13,b)
  c.setStrokeColor(MUTED)
  for x,y1,y2 in [(245,246,221),(117,174,143),(373,174,143),(117,90,58),(373,90,58)]:
   c.line(x,y1,x,y2);c.line(x,y2,x-3,y2+5);c.line(x,y2,x+3,y2+5)
add('ПАВЛОДАР / ТЗ РАЗРАБОТКИ / 1.0.0','label')
add('Платформа городского озеленения','title')
add('Полноценный продукт и совместная разработка GPT и Claude','h2')
add('Документ определяет пользовательские маршруты, архитектуру, данные, вычисления, 3D, интеграционные контракты и приёмку. Два агента работают над одним репозиторием и проверяют совместимость на каждом сквозном инкременте.')
table(['Параметр','Значение'],[
 ('Территория','Город Павлодар'),('Версия и дата','1.0.0 · 29.10.2026'),('Репозиторий','AIFESTHackathon2026/team-vtiposhnik'),('GitHub аккаунт','Mustiks07 · id 232028042'),('Состояние','ТЗ и контракты; реализация приложения ещё не начата'),('Данные организаторов','Не получены; открытые зависимости перечислены в DR-01..DR-07')],[145,346])
add('Дедлайны не используются для сокращения конечного объёма. Данные и научная применимость проверяются отдельно: отсутствующие наблюдения не заменяются выдуманными production-значениями. Готовность определяется критериями, а не внешним видом демонстрации.')
story.append(Spacer(1,16));add('Источник истины для текста: docs/TZ_DEVELOPMENT.txt. Контракты, реестры работ, задания агентам и проверяемые примеры поставляются рядом в репозитории.','small')
story.append(PageBreak());heading('Содержание')
toc=TableOfContents();toc.levelStyles=[ParagraphStyle('TOC',fontName='Body',fontSize=9,leading=13,spaceBefore=4,textColor=INK)];story.append(toc)
story.append(PageBreak());heading('Архитектура и разделение ответственности')
story.append(Architecture());story.append(Spacer(1,18))
table(['GPT','Claude'],[('Сервер, БД и миграции; расчёты и оптимизация; workers, auth, контракты, интеграция.','Интерфейс и дизайн-система; карта и 3D; редактор и сравнение; browser-проверки и UX.'),('Единый расчётный источник истины и версии данных.','Generated API client и отображение серверных фактов.')],[245.5,245.5])
add('Общее: один origin, отдельные рабочие каталоги/ветки, одна схема данных, строгие единицы, общие fixtures и небольшой интегрируемый результат на каждом шаге. Ни один агент не имеет права молча переопределить общий контракт.')
story.append(PageBreak())
source=(ROOT/'docs/TZ_DEVELOPMENT.txt').read_text(encoding='utf-8')
for line in source.splitlines():
 if line.startswith('## '):heading(line[3:])
 elif line.strip() and not line.startswith(('ТЕХНИЧЕСКОЕ ЗАДАНИЕ','Версия 1.0.0.','Заказчик исходной')):
  # Link references while keeping all normative source prose intact.
  content=escape(line)
  content=re.sub(r'(https://[^\s<>]+)',lambda m:'<link href="'+m.group(1).rstrip('.,')+'" color="#286953">'+m.group(1)+'</link>',content)
  add(content,'body',raw=True)
story.append(PageBreak());heading('Приложение А Передача работы двум агентам')
add('Полный регламент: docs/TEAM_PROTOCOL.txt. Стартовые задания: prompts/GPT_START.txt и prompts/CLAUDE_START.txt. AGENTS.md - общий источник инструкций; CLAUDE.md отсылает к нему. Одного совпадения имён аккаунта недостаточно: проверять и commit author, и фактическую аутентификацию push/PR.')
table(['Шаг','Действие и свидетельство'],[
 ('Общий старт','Оба читают ТЗ, подтверждают общий baseline SHA, версию контрактов и Mustiks07. Разные worktree/клоны и dev-порты.'),
 ('Задача','Выбирается пакет с закрытыми depends_on. Владелец пишет только свою часть; shared-файлы имеют одного writer.'),
 ('Контракт','Изменение сначала ADR + JSON до/после + миграция/совместимость; затем schema, fixtures, generated client и реализация.'),
 ('Интеграция','Ветка и commit SHA, команды/результаты, screenshots, data assumptions и blockers в handoff. Проверка с реальной БД/API.'),
 ('Готово','GPT интегрирует после review другой стороны и checks. Main не содержит сломанных переходных шагов; защита ветки не обходится.'),
 ],[90,401])
add('Два AI-агента не являются двумя независимыми человеческими approvals в GitHub. Если правила репозитория требуют стороннего одобрения, оно остаётся обязательным. Пользовательские права и чужие изменения сохраняются.')
story.append(PageBreak());heading('Приложение Б Пакеты работ')
tasks=json.loads((ROOT/'planning/work_packages.json').read_text(encoding='utf-8'))['packages']
for t in tasks:
 story.append(CondPageBreak(160));add(t['id']+' '+t['title'],'h2');add('Владелец: '+t['owner']+'. Зависимости: '+(', '.join(t['depends_on']) or 'нет')+'.','small')
 for x in t['deliverables']:add('• '+x)
 add('Интеграция: '+t['integration_evidence']);add('Приёмка: '+', '.join(t['acceptance_ids'])+'. Статус реализации: not_started.','small')
story.append(PageBreak());heading('Приложение В Задания на данные')
requests=json.loads((ROOT/'planning/data_requests.json').read_text(encoding='utf-8'))['requests']
for r in requests:
 story.append(CondPageBreak(180));add(r['id']+' '+r['title'],'h2');add('Приоритет '+r['priority']+'. Источник/владелец: '+r['source_owner']+'.','small')
 add('Требуется: '+'; '.join(r['required'])+'.');add('Формат сдачи: '+'; '.join(r['deliverables'])+'.');add('Приёмка данных: '+r['acceptance']+'.');add('Зависит: '+r['blocks']+'.');add('До получения: '+r['fallback']+'.')
story.append(PageBreak());heading('Приложение Г Реестр API')
add('Полные request/response schemas, required/nullability, статусы, security, CSRF, idempotency и ETag находятся в contracts/openapi.json. Ниже приведена навигация по операциям, а не замена машинного контракта.')
ops=json.loads((ROOT/'contracts/operations.json').read_text(encoding='utf-8'))
table(['Метод','Маршрут','Ответ'],[(o['method'],o['path'],str(o['success_status'])+' '+(o['response_schema'] or 'redirect / stream / empty')) for o in ops],[43,269,179])
story.append(PageBreak());heading('Приложение Д Проверка пакета ТЗ')
ev=json.loads((ROOT/'docs/evidence/spec_validation.json').read_text(encoding='utf-8'))
add('Проверка относится к целостности документации и контрактов. Готовность приложения, научная точность и performance criteria пока не проверены, поскольку приложение ещё не реализовано.')
table(['Проверено','Результат'],[('Схемы домена',str(ev['schema_count'])),('Операции API',str(ev['operation_count'])),('Положительные и отрицательные fixtures',str(ev['fixture_count'])),('Зависимости пакетов работ',str(ev['work_packages'])+' пакетов, цикл отсутствует'),('Критерии приёмки',str(ev['acceptance_criteria'])+' ссылок согласованы'),('OpenAPI validator / JSON Schema','Успешно')],[275,216])
add('Команда: python tools/spec/validate.py. Для Python-зависимостей tools/spec/requirements.txt. Состояния работ и критериев остаются not_started / not_tested; успешная валидация спецификации не закрывает ни один этап реализации.')
add('SHA256 исходного текста: '+hashlib.sha256(source.encode('utf-8')).hexdigest(),'small')
class Doc(BaseDocTemplate):
 def afterFlowable(self,flowable):
  if isinstance(flowable,Paragraph) and flowable.style.name=='Heading1' and flowable.getPlainText()!='Содержание':
   title=flowable.getPlainText();key='h'+hashlib.sha1(title.encode()).hexdigest();self.canv.bookmarkPage(key);self.canv.addOutlineEntry(title,key,level=0);self.notify('TOCEntry',(0,title,self.page,key))
def footer(c,doc):
 c.saveState();c.setStrokeColor(BORDER);c.line(52,43,543,43);c.setFont('Body',8);c.setFillColor(MUTED);c.drawString(52,29,'Павлодар · ТЗ разработки 1.0.0 · 29.10.2026');c.drawRightString(543,29,str(doc.page));c.restoreState()
path=ROOT/'docs/TZ_DEVELOPMENT.pdf';doc=Doc(str(path),pagesize=(595.28,841.89),title='ТЗ разработки платформы озеленения Павлодара',author='Mustiks07',leftMargin=52,rightMargin=52,topMargin=48,bottomMargin=58)
doc.addPageTemplates(PageTemplate(id='normal',frames=[Frame(52,58,491.28,735.89,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=footer))
doc.multiBuild(story)
print(path)
