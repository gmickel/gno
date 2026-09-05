import { chromium } from "playwright";
const dir=new URL(".",import.meta.url).pathname;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1380,height:880}});
const consoleRows:any[]=[];const responses:any[]=[];const pending:Promise<void>[]=[];
page.on("console",m=>consoleRows.push({type:m.type(),text:m.text()}));
page.on("pageerror",e=>consoleRows.push({type:"pageerror",text:String(e)}));
page.on("response",r=>{
 if(r.url().includes("/api/search"))pending.push((async()=>responses.push({url:r.url(),status:r.status(),request:r.request().postData(),body:await r.text()}))().then(()=>{}));
});
try{
 await page.goto("http://127.0.0.1:3349/search");
 await page.getByRole("button",{name:"Advanced Retrieval",exact:true}).waitFor();
 await Bun.write(`${dir}/initial-snapshot.txt`,await page.locator("body").ariaSnapshot());
 await page.getByRole("radio",{name:/^Fast/}).click();
 await page.getByRole("button",{name:"Advanced Retrieval",exact:true}).click();
 await page.getByPlaceholder("Search your documents... Use Shift+Enter for structured query documents",{exact:true}).fill("needle");
 const since=page.locator("input[type=date]").nth(0);
 const until=page.locator("input[type=date]").nth(1);
 await since.fill("2026-09-01");
 await until.fill("2026-09-02");
 await page.getByPlaceholder("gordon",{exact:true}).focus();
 const values={since:await since.inputValue(),until:await until.inputValue()};
 await page.getByRole("button",{name:"Search",exact:true}).last().click();
 await page.getByRole("heading",{name:"Target",exact:true}).waitFor();
 await page.screenshot({path:`${dir}/date-desktop.png`,fullPage:true});
 await Bun.write(`${dir}/date-snapshot.txt`,await page.locator("body").ariaSnapshot());
 await page.setViewportSize({width:375,height:812});
 await page.screenshot({path:`${dir}/date-mobile.png`,fullPage:true});
 const errorResponse=page.waitForResponse(r=>r.url().endsWith("/api/search")&&r.status()===400);
 await page.getByPlaceholder("Search your documents... Use Shift+Enter for structured query documents",{exact:true}).fill('"unterminated');
 await page.getByPlaceholder("Search your documents... Use Shift+Enter for structured query documents",{exact:true}).press("Enter");
 await errorResponse;
 await page.getByText(/Invalid search query:.*unmatched/).waitFor();
 await page.screenshot({path:`${dir}/invalid400-mobile.png`,fullPage:true});
 await Promise.all(pending);
 await Bun.write(`${dir}/date-result.json`,JSON.stringify({values,responses,console:consoleRows},null,2));
 console.log(JSON.stringify({values,responses:responses.map(r=>({status:r.status,request:r.request})),console:consoleRows}));
}finally{await browser.close();}
