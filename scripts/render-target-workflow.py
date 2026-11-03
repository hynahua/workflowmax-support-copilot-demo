"""Render the reviewed target diagram locally, without network or model calls."""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'diagrams' / 'workflow-chinese.png'
OUT.parent.mkdir(exist_ok=True)
im = Image.new('RGB', (1800, 2550), '#f5f8f6')
d = ImageDraw.Draw(im)
font_path = '/System/Library/Fonts/STHeiti Medium.ttc'
fonts = {s: ImageFont.truetype(font_path, s) for s in (24, 27, 30, 34, 46)}
ink, green, mint = '#143d35', '#287463', '#dceee6'

def text(x, y, value, size=30, color=ink):
    lines = value.split('\n')
    for i, line in enumerate(lines):
        box = d.textbbox((0, 0), line, font=fonts[size])
        d.text((x-(box[2]-box[0])/2, y+i*(size+12)), line, font=fonts[size], fill=color)

def box(cx, y, label, width=480, height=94, fill='white', size=30):
    d.rounded_rectangle((cx-width/2, y, cx+width/2, y+height), radius=18, fill=fill, outline=green, width=3)
    n = label.count('\n')+1
    text(cx, y+(height-n*(size+12))/2+3, label, size)

def arrow(points, label=None, at=None):
    d.line(points, fill=green, width=4, joint='curve')
    x,y=points[-1]; px,py=points[-2]
    angle=math.atan2(y-py,x-px)
    d.polygon([(x,y),(x-15*math.cos(angle-.45),y-15*math.sin(angle-.45)),(x-15*math.cos(angle+.45),y-15*math.sin(angle+.45))],fill=green)
    if label and at:
        b=d.textbbox((0,0),label,font=fonts[24]); w=b[2]-b[0]
        d.rectangle((at[0]-w/2-6,at[1]-3,at[0]+w/2+6,at[1]+31),fill='#f5f8f6')
        text(*at,label,24)

def dashed_rect(bounds):
    x1,y1,x2,y2=bounds
    for x in range(x1,x2,26):
        for y in (y1,y2): d.line((x,y,min(x+15,x2),y),fill=green,width=3)
    for y in range(y1,y2,26):
        for x in (x1,x2): d.line((x,y,x,min(y+15,y2)),fill=green,width=3)

text(900,35,'WorkflowMAX 客服邮件目标流程',46)
text(900,100,'评审版设计 · 尚未实现邮件集成 · 普通操作答案保留人工审核',24)
box(900,160,'开始：收到邮件',fill=mint)
box(900,290,'格式检查＋恢复对话上下文')
arrow([(900,254),(900,290)])
dashed_rect((610,430,1190,720))
text(900,446,'阶段一：一次 LLM 调用＋程序校验',27)
box(900,500,'理解邮件：人工请求、意图、风险\n缺失信息与检索方向',height=105,size=27)
box(900,635,'程序校验与分流规则',height=65,size=27)
arrow([(900,384),(900,430)])
arrow([(900,487),(900,500)])
arrow([(900,605),(900,635)])
box(900,785,'可以继续：检索相关知识段落',height=95)
arrow([(900,700),(900,785)])
box(285,785,'需要客户补充信息\nAI 生成具体澄清问题',width=450,height=105,size=27)
arrow([(660,665),(545,665),(545,837),(510,837)])
box(285,1015,'程序检查澄清问题\n失败或有风险 → 人工处理',width=450,height=105,size=27)
arrow([(285,890),(285,1015)])
box(285,1240,'检查通过：自动发送',width=450,fill=mint,size=27)
arrow([(285,1120),(285,1240)])
box(285,1460,'等待客户回复',width=450,size=27)
arrow([(285,1334),(285,1460)])
box(285,1670,'合并原邮件、已问问题和新回复',width=450,height=105,size=24)
arrow([(285,1554),(285,1670)])
arrow([(60,1722),(25,1722),(25,337),(660,337)])
text(285,1860,'补充回复回到阶段一重新判断',24)
box(900,1015,'阶段二：一次 LLM 调用\n判断证据适用性，有依据则拟稿',height=115,size=27)
arrow([(900,880),(900,1015)],'检索到相关资料',(1020,930))
arrow([(660,1070),(545,1070),(545,837),(510,837)])
text(560,945,'仍缺客户信息',24)
box(900,1240,'程序检查草稿\n格式、引用与固定规则',height=105,size=27)
arrow([(900,1130),(900,1240)])
box(1490,1430,'可修复且重试少于三次？\n是：带错误反馈重试阶段二\n否／耗尽：交人工',width=460,height=150,size=24)
arrow([(1140,1292),(1490,1292),(1490,1430)],'检查失败',(1370,1250))
arrow([(1720,1505),(1760,1505),(1760,1072),(1140,1072)])
text(1500,1140,'最多三次重试；通过即停止',24)
box(1490,1775,'人工处理\n人工请求／风险／证据不足或冲突',width=460,height=105,size=24)
arrow([(1490,1580),(1490,1775)])
arrow([(1140,665),(1230,665),(1230,1810),(1260,1810)])
text(1465,650,'明确要求人工／风险／阶段一失败',24)
arrow([(1140,835),(1230,835)])
text(1450,805,'检索为空 → 额外来源或人工',24)
arrow([(1140,1045),(1230,1045)])
text(1470,995,'证据不足／冲突／风险 → 人工',24)
box(900,1775,'客服审核与编辑操作草稿',height=105,fill=mint,size=27)
arrow([(900,1345),(900,1775)],'检查通过，直接交客服',(900,1510))
arrow([(1260,1830),(1140,1830)])
box(900,1995,'明确批准后：保存最终正文与审核记录',fill=mint,size=24)
arrow([(900,1880),(900,1995)])
text(1450,1940,'未批准：保存修改或拒绝记录，不发送',24)
box(900,2160,'发送已批准的邮件给客户',fill=mint,size=27)
arrow([(900,2089),(900,2160)])
box(900,2325,'记录发送结果\n失败或状态不明：交客服核对',height=105,size=27)
arrow([(900,2254),(900,2325)])
text(900,2490,'目标设计 · 现有 demo 仍无真实邮件收发能力',24)
im.save(OUT)
print(OUT)
