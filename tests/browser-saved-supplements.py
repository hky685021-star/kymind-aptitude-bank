"""Local browser QA. Start `python3 -m http.server 8791 --bind 127.0.0.1` first.

Requires Playwright and Chromium. Uses only fixture UI state, never writes bank data.
"""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('KYMIND_TEST_URL', 'http://127.0.0.1:8791')
QID = 'q_00013f5f09f985a0d167a5822f6c7f699e977754d1ff71c7d11ee7cafea2898e'
PAPER = 'collection_363da2db5f3a46af6a2642cac08a1ebdbf61c2f0408fe2a77344dd98be13c7cb'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1280, 'height':900})
    errors = []
    requests = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: requests.append(req.url) if '/supplements/reader/' in req.url else None)
    page.goto(BASE + '/online/practice.html')
    page.locator('#scope-trigger').wait_for(state='visible')
    expect(page.locator('#scope-trigger')).to_be_enabled(timeout=60000)
    assert not requests, 'sidecars must not prefetch before a click'
    page.locator('#scope-trigger').click()
    page.locator('#collection-options label').filter(has_text='2016年423公务员联考《行测》河北卷.html').locator('input').check()
    page.locator('#apply-scope').click()
    page.locator(f'#list [data-question-id="{QID}"]').click(timeout=120000)
    ai = page.get_by_role('button', name='AI解析', exact=True)
    ai.wait_for()
    assert not requests, 'selecting a question must not fetch sidecars'
    ai.click()
    panel = page.locator('[aria-label="AI解析"]')
    expect(panel).to_contain_text('重点解析')
    expect(panel).to_contain_text('秒杀技巧')
    expect(panel).to_contain_text(re.compile('待复核稿|已复核的保存稿|已阻断'))
    expect(page.locator('#solution')).to_be_hidden()
    page.get_by_role('button', name='模型索引', exact=True).click()
    expect(page.locator('[aria-label="模型索引"]')).to_contain_text('候选模型索引')
    page.locator('#submit').click()
    expect(page.locator('#solution')).to_be_visible()
    page.get_by_role('button', name='收起AI解析', exact=True).click()
    expect(panel).to_be_hidden()
    expect(page.locator('#solution')).to_be_visible()
    expect(page.locator('[aria-label="模型索引"]')).to_be_visible()
    page.locator('#hide-solution').click()
    expect(page.locator('#solution')).to_be_hidden()
    page.get_by_role('button', name='AI解析', exact=True).click()
    expect(panel).to_be_visible()
    expect(page.locator('#solution')).to_be_hidden()
    # Navigation clears the former controls and never shows the preceding question's answer.
    page.locator('#next').click()
    expect(page.locator('#single-supplement-panels')).to_have_count(1)
    expect(page.locator('[aria-label="AI解析"]')).to_be_hidden()
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'mobile horizontal overflow'
    assert not errors, errors

    # Focused DOM checks inject literal public strings, and exercise failed/absent/retry/race states.
    page.goto(BASE + '/online/index.html')
    page.evaluate("""async () => {
      const {createSupplementControls}=await import('./supplement-view.mjs');
      const {renderSupplement}=await import('./supplement-view.mjs');
      const area=document.createElement('div');area.id='fixture';document.body.append(area);
      const unsafe=document.createElement('section');unsafe.id='untrusted';area.append(unsafe);
      renderSupplement(unsafe,'ai',{state:'ready',ai:{reviewStatus:'reviewed',focusAnalysis:'<img src=x onerror=alert(1)><script>alert(1)</script>',quickTip:'本题无可靠秒杀技巧',sourceIssues:[],batchId:'test'}});
      window.fixtureCalls=0; window.fixtureMode='fail';
      const client={refresh(){},async get(){window.fixtureCalls++;if(window.fixtureMode==='fail')throw Error('network_http_404');return {state:'missing'};}};
      const controls=createSupplementControls({client,question:{}});area.append(controls.buttons,controls.panels);
    }""")
    assert page.locator('#untrusted img, #untrusted script').count() == 0
    expect(page.locator('#untrusted')).to_contain_text('<script>alert(1)</script>')
    page.locator('#fixture').get_by_role('button', name='AI解析', exact=True).click()
    expect(page.locator('#fixture [aria-label="AI解析"]')).to_contain_text('补充加载失败')
    assert '尚未保存' not in page.locator('#fixture [aria-label="AI解析"]').inner_text()
    page.evaluate("window.fixtureMode='missing'")
    page.get_by_role('button', name='重试加载', exact=True).click()
    expect(page.locator('#fixture [aria-label="AI解析"]')).to_contain_text('本题尚未保存 AI 解析')
    assert page.evaluate('window.fixtureCalls') == 2
    page.evaluate("""async () => {
      const {createSupplementControls}=await import('./supplement-view.mjs');
      window.raceCalls=0;
      const client={refresh(){},get(){window.raceCalls++;return new Promise(resolve=>window.finishRace=resolve);}};
      const controls=createSupplementControls({client,question:{}});controls.buttons.id='race-buttons';controls.panels.id='race-panels';document.body.append(controls.buttons,controls.panels);
    }""")
    race = page.locator('#race-buttons button').first
    race.click(); race.click(); race.click(); race.click()
    page.evaluate("window.finishRace({state:'missing'})")
    expect(page.locator('#race-panels section').first).to_be_hidden()
    assert page.evaluate('window.raceCalls') == 1

    # Suite integration: one set of independent controls per practice-ready card.
    page.set_viewport_size({'width':1280,'height':900})
    page.goto(BASE + '/online/exam.html?paper=' + PAPER)
    page.locator(f'.suite-card[data-question-id="{QID}"] .supplement-buttons').wait_for(timeout=120000)
    card=page.locator(f'.suite-card[data-question-id="{QID}"]')
    card.get_by_role('button',name='AI解析',exact=True).click()
    expect(card.locator('[aria-label="AI解析"]')).to_contain_text('重点解析')
    expect(card.locator('.solution')).to_be_hidden()
    card.get_by_role('button',name='模型索引',exact=True).click()
    expect(card.locator('[aria-label="模型索引"]')).to_contain_text('候选模型索引')
    card.get_by_role('button',name='收起AI解析',exact=True).click()
    expect(card.locator('[aria-label="AI解析"]')).to_be_hidden()
    expect(card.locator('[aria-label="模型索引"]')).to_be_visible()
    assert not errors, errors
    browser.close()
print(json.dumps({'result':'passed','checks':['real saved sample','independent original/AI/model toggles','navigation reset','mobile overflow','text-only rendering','404 failure versus absence','retry','rapid toggle race','suite integration']}, ensure_ascii=False))
