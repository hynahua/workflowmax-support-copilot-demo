"""Render the reviewed Mermaid topology as a single-page interview diagram.

Run with the bundled document Python runtime (ReportLab and Pillow). No network,
application provider, customer data or model request is involved. The Mermaid
file remains the source of node text, branch labels and directed relationships.
"""

from pathlib import Path
import hashlib
import html
import json
import math
import re

from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/workflow-topology.mmd"
BASE = ROOT / "diagrams/Workflow"
W, H = 1191, 1684  # A2 portrait, in PDF points; one continuous vector page.
INK = "#193040"
MUTED = "#526575"
MAIN = "#315F79"
CLARIFY = "#397995"
HUMAN = "#95622C"
REPAIR = "#76618D"


def read_source():
    text = SOURCE.read_text()
    nodes, edges = {}, []
    pattern = re.compile(r"\b([A-Z][A-Z0-9_]*)\s*(\(\[([^\]]+)\]\)|\[([^\]]+)\]|\{([^}]+)\})")
    for line in text.splitlines():
        if line.strip().startswith(("subgraph", "style")):
            continue
        for m in pattern.finditer(line):
            nodes[m[1]] = {
                "label": m[3] or m[4] or m[5],
                "shape": "terminal" if m[3] else "process" if m[4] else "decision",
            }
        if "-->" in line:
            first, last = line.split("-->", 1)
            source = re.match(r"\s*([A-Z0-9_]+)", first)[1]
            last = last.strip()
            label = None
            if last.startswith("|"):
                _, label, last = last.split("|", 2)
            target = re.match(r"\s*([A-Z0-9_]+)", last)[1]
            edges.append({"from": source, "to": target, "label": label})
    assert len(nodes) == 26 and len(edges) == 33
    return text, nodes, edges


source_text, nodes, edges = read_source()
pdfmetrics.registerFont(TTFont("Arial", "/System/Library/Fonts/Supplemental/Arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"))


class Drawing:
    def __init__(self):
        self.c = canvas.Canvas(str(BASE.with_suffix(".pdf")), pagesize=(W, H), pageCompression=1)
        self.c.setTitle("Workflow")
        self.c.setAuthor("WorkflowMAX Support Copilot")
        self.c.setSubject("Single-page English workflow; reviewed node meanings and routing preserved")
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
                    '<title id="title">Workflow</title>',
                    '<desc id="desc">A single-page English flowchart with a vertical main path, clarification at left, repair at right, and human handling before approval. Matching C and H circles are connectors on this same page. The source contains 26 process or decision nodes and 33 directed relationships. The prototype uses only a TEST outbox.</desc>',
                    '<rect width="1191" height="1684" fill="white"/>']
        self.text_boxes = []
        self.routes = []

    def group(self, attrs):
        self.svg.append('<g ' + ' '.join(f'{k}="{html.escape(str(v), quote=True)}"' for k, v in attrs.items()) + '>')

    def end(self):
        self.svg.append('</g>')

    def line(self, pts, color=MUTED, width=1.5, arrow=True, dash=None):
        self.c.setStrokeColor(color)
        self.c.setLineWidth(width)
        self.c.setDash(dash or [])
        p = self.c.beginPath()
        for i, (x, y) in enumerate(pts):
            (p.moveTo if i == 0 else p.lineTo)(x, H-y)
        self.c.drawPath(p)
        self.c.setDash([])
        d = " ".join(f'{"M" if i == 0 else "L"}{x},{y}' for i, (x, y) in enumerate(pts))
        dashed = f' stroke-dasharray="{",".join(str(n) for n in dash)}"' if dash else ''
        self.svg.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"{dashed}/>')
        if arrow:
            x, y = pts[-1]
            px, py = pts[-2]
            angle = math.atan2(y-py, x-px)
            tri = [(x,y)] + [(x-7*math.cos(angle+a), y-7*math.sin(angle+a)) for a in (-.42, .42)]
            self.polygon(tri, color, color, .4)

    def rect(self, x, y, w, h, fill="white", stroke="#91A1AD", radius=4, width=1.2, dash=None):
        self.c.setFillColor(fill)
        self.c.setStrokeColor(stroke)
        self.c.setLineWidth(width)
        self.c.setDash(dash or [])
        self.c.roundRect(x, H-y-h, w, h, radius, stroke=1, fill=1)
        self.c.setDash([])
        dashed = f' stroke-dasharray="{",".join(str(n) for n in dash)}"' if dash else ''
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"{dashed}/>')

    def polygon(self, pts, fill, stroke, width=1.2):
        self.c.setFillColor(fill)
        self.c.setStrokeColor(stroke)
        self.c.setLineWidth(width)
        self.c.setDash([])
        p = self.c.beginPath()
        p.moveTo(pts[0][0], H-pts[0][1])
        for x,y in pts[1:]:
            p.lineTo(x,H-y)
        p.close()
        self.c.drawPath(p,stroke=1,fill=1)
        pts_str = " ".join(f'{x},{y}' for x,y in pts)
        self.svg.append(f'<polygon points="{pts_str}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')

    def circle(self, x, y, r, fill, stroke=None):
        self.c.setFillColor(fill)
        self.c.setStrokeColor(stroke or fill)
        self.c.setLineWidth(1)
        self.c.circle(x,H-y,r,stroke=1,fill=1)
        self.svg.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke or fill}"/>')

    def text(self, x, y, text, size=13.5, color=INK, bold=False, align="middle", leading=None, halo=False):
        # y is the baseline of the first line, in a top-origin coordinate system.
        lines = text.split("\n")
        font = "Arial-Bold" if bold else "Arial"
        leading = leading or size*1.25
        for i,line in enumerate(lines):
            yy = y+i*leading
            tw = pdfmetrics.stringWidth(line,font,size)
            xx = x if align=="start" else x-tw if align=="end" else x-tw/2
            if halo:
                self.c.setFillColor("white")
                self.c.rect(xx-3,H-yy-3,tw+6,size+5,fill=1,stroke=0)
                self.svg.append(f'<rect x="{xx-3}" y="{yy-size-2}" width="{tw+6}" height="{size+5}" fill="white"/>')
            self.c.setFillColor(color)
            self.c.setFont(font,size)
            self.c.drawString(xx,H-yy,line)
            self.svg.append(f'<text x="{x}" y="{yy}" text-anchor="{align}" font-family="Arial, Helvetica, sans-serif" font-size="{size}" font-weight="{700 if bold else 400}" fill="{color}">{html.escape(line)}</text>')
            self.text_boxes.append([xx, yy-size, xx+tw, yy+3, line])

    def block(self, x, y, lines, size=13.5, color=INK, bold=False, leading=None):
        leading = leading or size*1.25
        self.text(x,y-(len(lines)-1)*leading/2+size*.34,"\n".join(lines),size,color,bold,leading=leading)

    def save(self):
        self.c.showPage()
        self.c.save()
        self.svg.append('</svg>')
        BASE.with_suffix('.svg').write_text('\n'.join(self.svg))


D = Drawing()
D.text(48,48,"WORKFLOWMAX SUPPORT COPILOT",12,MUTED,True,align="start")
D.text(48,84,"Workflow",28,INK,True,align="start")
D.text(48,111,"Two model stages  |  Program checks  |  Explicit human approval before the final reply",13,MUTED,align="start")
D.line([(48,133),(1143,133)],"#D5DEE5",.9,False)
D.text(50,158,"CLARIFY AND RESUME",11,CLARIFY,True,align="start")
D.text(425,158,"MAIN WORKFLOW",11,MAIN,True,align="start")
D.text(855,158,"REPAIR AND HUMAN HANDLING",11,HUMAN,True,align="start")

# Shared geometry. Text uses only original node labels, with deliberate wrapping.
layout = {
    "START": (595,185,214,34,["Receive email"]),
    "INPUT": (595,250,340,54,["Check input format and restore","conversation context"]),
    "AI1": (595,371,340,76,["One LLM call: human request,", "multiple intents, risk,", "missing information, search direction"]),
    "CHECK1": (595,442,340,48,["Program validates analysis and", "enforces routing constraints"]),
    "ROUTE": (595,535,180,70,["Next step"]),
    "SEARCH": (595,624,340,48,["Retrieve relevant knowledge passages"]),
    "EMPTY": (595,708,190,70,["Retrieval empty?"]),
    "AI2": (595,803,340,68,["Stage 2: One LLM call to assess", "evidence applicability and draft"]),
    "VALIDATE": (595,909,340,56,["Program checks format, citations", "and fixed constraints"]),
    "REVIEW": (595,1035,340,48,["Support reviews and edits"]),
    "APPROVE": (595,1124,210,72,["Support approves", "sending?"]),
    "SAVE": (595,1209,340,52,["Save approved final text", "and review record"]),
    "SENDANSWER": (595,1296,340,60,["Send the approved email to the", "customer: target integration"]),
    "SENT": (595,1389,200,76,["Delivery service", "result"]),
    "DONE": (595,1484,340,44,["Save sent status and delivery receipt"]),
    "ASK": (190,535,280,60,["AI prepares a specific", "clarification question"]),
    "ASKCHECK": (190,665,260,100,["Program checks", "clarification question"]),
    "SEND": (190,795,280,58,["Automatically send clarification:", "target integration"]),
    "WAIT": (190,895,280,46,["Wait for customer reply"]),
    "MERGE": (190,995,280,62,["Merge original email, question", "and new reply"]),
    "HOLD": (190,1124,280,62,["Save edits or rejection record;", "do not send"]),
    "GAP": (995,708,280,70,["Seek additional approved", "sources or hand off"]),
    "RETRY": (995,925,260,110,["Repairable and fewer", "than 3 retries?"]),
    "FEEDBACK": (995,1055,280,62,["Keep evidence and constraints;", "add error feedback"]),
    "HUMAN": (995,1175,280,56,["Human handling"]),
    "SENDFAIL": (995,1389,280,60,["Record failed or uncertain", "delivery; support checks"]),
}
assert set(layout)==set(nodes)
for key, (_,_,_,_,lines) in layout.items():
    assert " ".join(lines)==nodes[key]["label"], key

D.rect(405,300,380,184,"#F6FAFC","#94AFBF",5,.9,[5,4])
D.text(425,312,"Stage 1: Understand",11.5,MAIN,True,align="start")
D.text(425,326,"and triage",11.5,MAIN,True,align="start")

routes = {
    ("START","INPUT"): [(595,202),(595,223)],
    ("INPUT","AI1"): [(595,277),(595,333)],
    ("AI1","CHECK1"): [(595,409),(595,418)],
    ("CHECK1","ROUTE"): [(595,466),(595,500)],
    ("ROUTE","HUMAN"): [(685,535),(985,535)],
    ("ROUTE","ASK"): [(505,535),(330,535)],
    ("ROUTE","SEARCH"): [(595,570),(595,600)],
    ("SEARCH","EMPTY"): [(595,648),(595,673)],
    ("EMPTY","GAP"): [(690,708),(855,708)],
    ("GAP","HUMAN"): [(995,743),(995,770)],
    ("EMPTY","AI2"): [(595,743),(595,769)],
    ("AI2","ASK"): [(425,803),(390,803),(390,850),(380,850)],
    ("AI2","HUMAN"): [(765,803),(1095,803)],
    ("AI2","VALIDATE"): [(595,837),(595,881)],
    ("VALIDATE","RETRY"): [(765,909),(835,909),(835,925),(865,925)],
    ("RETRY","FEEDBACK"): [(995,980),(995,1024)],
    ("FEEDBACK","AI2"): [(1135,1055),(1160,1055),(1160,850),(790,850),(790,824),(765,824)],
    ("RETRY","HUMAN"): [(1125,925),(1142,925),(1142,975)],
    ("VALIDATE","REVIEW"): [(595,937),(595,1011)],
    ("ASK","ASKCHECK"): [(190,565),(190,615)],
    ("ASKCHECK","HUMAN"): [(320,665),(370,665)],
    ("ASKCHECK","SEND"): [(190,715),(190,766)],
    ("SEND","WAIT"): [(190,824),(190,872)],
    ("WAIT","MERGE"): [(190,918),(190,964)],
    ("MERGE","INPUT"): [(50,995),(25,995),(25,250),(425,250)],
    ("HUMAN","REVIEW"): [(855,1175),(815,1175),(815,1035),(765,1035)],
    ("REVIEW","APPROVE"): [(595,1059),(595,1088)],
    ("APPROVE","HOLD"): [(490,1124),(330,1124)],
    ("APPROVE","SAVE"): [(595,1160),(595,1183)],
    ("SAVE","SENDANSWER"): [(595,1235),(595,1266)],
    ("SENDANSWER","SENT"): [(595,1326),(595,1351)],
    ("SENT","DONE"): [(595,1427),(595,1462)],
    ("SENT","SENDFAIL"): [(695,1389),(855,1389)],
}
label_positions = {
    ("ROUTE","HUMAN"): (835,509,["Human requested, risk", "or analysis failure"]),
    ("ROUTE","ASK"): (410,510,["Missing required", "customer information"]),
    ("ROUTE","SEARCH"): (649,589,["Can proceed"]),
    ("EMPTY","GAP"): (775,697,["Yes"]),
    ("EMPTY","AI2"): (617,761,["No"]),
    ("AI2","ASK"): (295,842,["Need customer", "information"]),
    ("AI2","HUMAN"): (930,823,["Insufficient or conflicting", "evidence, or risk"]),
    ("AI2","VALIDATE"): (687,861,["Actionable draft produced"]),
    ("VALIDATE","RETRY"): (803,898,["Fail"]),
    ("RETRY","FEEDBACK"): (995,1000,["Yes: log error and retry count"]),
    ("RETRY","HUMAN"): (1128,958,["No"]),
    ("VALIDATE","REVIEW"): (619,978,["Pass"]),
    ("ASKCHECK","HUMAN"): (366,702,["Fail or human", "judgment needed"]),
    ("ASKCHECK","SEND"): (216,747,["Pass"]),
    ("APPROVE","HOLD"): (412,1113,["No"]),
    ("APPROVE","SAVE"): (618,1176,["Yes"]),
    ("SENT","DONE"): (628,1447,["Success"]),
    ("SENT","SENDFAIL"): (777,1378,["Failed or unknown"]),
}
assert set(routes)=={(e['from'],e['to']) for e in edges}
assert len(label_positions)==18
for edge in edges:
    key = edge['from'],edge['to']
    color = MAIN
    if key in [("VALIDATE","RETRY"),("RETRY","FEEDBACK"),("FEEDBACK","AI2")]:
        color = REPAIR
    elif edge['to']=="HUMAN" or edge['from']=="HUMAN":
        color = HUMAN
    elif edge['from'] in {"ASK","ASKCHECK","SEND","WAIT","MERGE"} or edge['to']=="ASK":
        color = CLARIFY
    elif key in [("APPROVE","HOLD"),("SENT","SENDFAIL")]:
        color = MUTED
    via = "H" if edge['to']=="HUMAN" else "C" if key==("AI2","ASK") else ""
    D.group({"id":f"edge-{edge['from']}-{edge['to']}","class":"semantic-edge", "data-from":edge['from'],"data-to":edge['to'],"data-label":edge['label'] or "", "data-via":via})
    D.svg.append('<title>'+html.escape(f"{edge['from']} to {edge['to']}"+(": "+edge['label'] if edge['label'] else ""))+'</title>')
    D.line(routes[key],color,1.55)
    D.end()

# Matching circles are on-page continuations, not extra model or decision nodes.
connectors = [(995,535,"H"),(995,780,"H"),(1105,803,"H"),(1142,985,"H"),(380,665,"H"),(370,850,"C"),(190,477,"C"),(995,1105,"H")]
D.group({"id":"on-page-connectors","data-role":"same-page-continuation"})
D.line([(190,487),(190,505)],CLARIFY)
D.line([(995,1115),(995,1147)],HUMAN)
for x,y,letter in connectors:
    color = CLARIFY if letter=="C" else HUMAN
    D.circle(x,y,10,color)
    D.text(x,y+3.5,letter,10.5,"#FFFFFF",True)
D.end()

for node_id,(x,y,w,h,lines) in layout.items():
    shape = nodes[node_id]['shape']
    fill, stroke = "#FFFFFF", "#889AA7"
    if node_id in {"AI1","AI2"}:
        fill,stroke = "#EAF3F8",MAIN
    elif node_id in {"ASK","ASKCHECK","SEND","WAIT","MERGE"}:
        fill,stroke = "#F3F8FB",CLARIFY
    elif node_id in {"RETRY","FEEDBACK"}:
        fill,stroke = "#F7F4FA",REPAIR
    elif node_id in {"HUMAN","REVIEW","APPROVE"}:
        fill,stroke = "#FCF7EE",HUMAN
    elif node_id in {"START","DONE"}:
        fill,stroke = "#EDF4F7",MAIN
    D.group({"id":"node-"+node_id,"class":"semantic-node","data-label":nodes[node_id]['label'],"data-shape":shape})
    D.svg.append('<title>'+html.escape(nodes[node_id]['label'])+'</title>')
    if shape=="decision":
        D.polygon([(x,y-h/2),(x+w/2,y),(x,y+h/2),(x-w/2,y)],fill,stroke)
    else:
        D.rect(x-w/2,y-h/2,w,h,fill,stroke,h/2 if shape=="terminal" else 3)
    size = 13.2 if node_id in {"AI1","SEND","ASKCHECK","RETRY"} else 13.5
    if node_id in {"ROUTE","HUMAN"}:
        size = 14
    D.block(x,y,lines,size,bold=node_id in {"START","HUMAN"})
    D.end()

for key,(x,y,lines) in label_positions.items():
    assert " ".join(lines)==next(e['label'] for e in edges if (e['from'],e['to'])==key),key
    D.group({"class":"branch-label","data-for":f"edge-{key[0]}-{key[1]}"})
    D.text(x,y,"\n".join(lines),11,INK,leading=13.5,halo=True)
    D.end()

# Notes clarify existing review conditions; they add no executable routing.
D.text(855,1230,"Human handling precedes review.",11,HUMAN,align="start")
D.text(855,1246,"It does not approve a reply.",11,HUMAN,align="start")
D.text(855,1300,"Repair limit",11,REPAIR,True,align="start")
D.text(855,1317,"1 initial draft + up to 3 repairs",11,REPAIR,align="start")
D.text(855,1333,"= 4 draft attempts maximum",11,REPAIR,align="start")
D.text(855,1445,"Check an unknown result before",11,MUTED,align="start")
D.text(855,1461,"any resend to avoid duplicates.",11,MUTED,align="start")
D.text(50,1060,"Reply received: restore the full context",11,CLARIFY,align="start")
D.text(50,1076,"and run understanding and triage again.",11,CLARIFY,align="start")

D.line([(48,1542),(1143,1542)],"#D5DEE5",.9,False)
D.text(48,1568,"HOW TO READ",10.5,MUTED,True,align="start")
D.circle(188,1564,9,CLARIFY)
D.text(188,1567,"C",10,"#FFFFFF",True)
D.text(205,1568,"Continue at the C circle above clarification.",11,MUTED,align="start")
D.circle(593,1564,9,HUMAN)
D.text(593,1567,"H",10,"#FFFFFF",True)
D.text(610,1568,"Continue at the H circle above Human handling.",11,MUTED,align="start")
D.text(48,1590,"All matching circles connect within this page. Rectangles are processes; diamonds are decisions.",11,MUTED,align="start")
D.text(48,1623,"PROTOTYPE BOUNDARY",10.5,INK,True,align="start")
D.text(48,1644,"The current prototype uses a TEST outbox only. Real customer email remains a target integration.",12,INK,align="start")
D.save()

proof = {
    "source": str(SOURCE.relative_to(ROOT)),
    "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "page_size": {"name":"A2 portrait", "width_pt":W, "height_pt":H},
    "nodes":nodes,"edges":edges,
    "node_count":len(nodes),"edge_count":len(edges),"labelled_edge_count":len(label_positions),
    "same_page_connector_letters":["C","H"],
    "content_note":"All original node and branch-label words retained; manual line breaks only.",
    "node_geometry":{k:list(v[:4]) for k,v in layout.items()},
    "routes":[{"from":a,"to":b,"points":pts} for (a,b),pts in routes.items()],
    "text_bounds":D.text_boxes,
    "outputs":{ext: {"path":str(BASE.with_suffix('.'+ext).relative_to(ROOT)),"sha256":hashlib.sha256(BASE.with_suffix('.'+ext).read_bytes()).hexdigest()} for ext in ['pdf','svg']},
}
proof_path = ROOT/'runtime/interview-prep/publication-flowchart-2026-11-03.json'
proof_path.parent.mkdir(parents=True,exist_ok=True)
proof_path.write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({"pdf":str(BASE.with_suffix('.pdf')),"svg":str(BASE.with_suffix('.svg')),"nodes":len(nodes),"edges":len(edges)},indent=2))
