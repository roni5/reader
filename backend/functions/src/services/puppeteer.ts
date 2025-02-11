import os from 'os';
import fs from 'fs';
import { container, singleton } from 'tsyringe';
import { AsyncService, Defer, marshalErrorLike, AssertionFailureError, delay, Deferred, perNextTick } from 'civkit';
import { Logger } from '../shared/services/logger';

import type { Browser, CookieParam, GoToOptions, HTTPResponse, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';

import puppeteerBlockResources from 'puppeteer-extra-plugin-block-resources';
import puppeteerPageProxy from 'puppeteer-extra-plugin-page-proxy';
import { SecurityCompromiseError, ServiceCrashedError, ServiceNodeResourceDrainError } from '../shared/lib/errors';
import { TimeoutError } from 'puppeteer';
import _ from 'lodash';
const tldExtract = require('tld-extract');

const READABILITY_JS = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf-8');


export interface ImgBrief {
    src: string;
    loaded?: boolean;
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    alt?: string;
}

export interface ReadabilityParsed {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
    publishedTime: string;
}

export interface PageSnapshot {
    title: string;
    description?: string;
    href: string;
    rebase?: string;
    html: string;
    text: string;
    status?: number;
    statusText?: string;
    parsed?: Partial<ReadabilityParsed> | null;
    screenshot?: Buffer;
    pageshot?: Buffer;
    imgs?: ImgBrief[];
    pdfs?: string[];
    maxElemDepth?: number;
    elemCount?: number;
    childFrames?: PageSnapshot[];
}

export interface ExtendedSnapshot extends PageSnapshot {
    links: { [url: string]: string; };
    imgs: ImgBrief[];
}

export interface ScrappingOptions {
    proxyUrl?: string;
    cookies?: CookieParam[];
    favorScreenshot?: boolean;
    waitForSelector?: string | string[];
    minIntervalMs?: number;
    overrideUserAgent?: string;
    timeoutMs?: number;
    locale?: string;
    referer?: string;
}


const puppeteerStealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(puppeteerStealth());
// const puppeteerUAOverride = require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
// puppeteer.use(puppeteerUAOverride({
//     userAgent: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`,
//     platform: `Linux`,
// }))

puppeteer.use(puppeteerBlockResources({
    blockedTypes: new Set(['media']),
    interceptResolutionPriority: 1,
}));
puppeteer.use(puppeteerPageProxy({
    interceptResolutionPriority: 1,
}));

const SCRIPT_TO_INJECT_INTO_FRAME = `
${READABILITY_JS}

function briefImgs(elem) {
    const imageTags = Array.from((elem || document).querySelectorAll('img[src],img[data-src]'));

    return imageTags.map((x)=> {
        let linkPreferredSrc = x.src;
        if (linkPreferredSrc.startsWith('data:')) {
            if (typeof x.dataset?.src === 'string' && !x.dataset.src.startsWith('data:')) {
                linkPreferredSrc = x.dataset.src;
            }
        }

        return {
            src: new URL(linkPreferredSrc, document.baseURI).toString(),
            loaded: x.complete,
            width: x.width,
            height: x.height,
            naturalWidth: x.naturalWidth,
            naturalHeight: x.naturalHeight,
            alt: x.alt || x.title,
        };
    });
}
function getMaxDepthAndCountUsingTreeWalker(root) {
  let maxDepth = 0;
  let currentDepth = 0;
  let elementCount = 0;

  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    (node) => {
      const nodeName = node.nodeName.toLowerCase();
      return (nodeName === 'svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
    false
  );

  while (true) {
    maxDepth = Math.max(maxDepth, currentDepth);
    elementCount++; // Increment the count for the current node

    if (treeWalker.firstChild()) {
      currentDepth++;
    } else {
      while (!treeWalker.nextSibling() && currentDepth > 0) {
        treeWalker.parentNode();
        currentDepth--;
      }

      if (currentDepth <= 0) {
        break;
      }
    }
  }

  return {
    maxDepth: maxDepth + 1,
    elementCount: elementCount
  };
}

function giveSnapshot(stopActiveSnapshot) {
    if (stopActiveSnapshot) {
        window.haltSnapshot = true;
    }
    let parsed;
    try {
        parsed = new Readability(document.cloneNode(true)).parse();
    } catch (err) {
        void 0;
    }
    const domAnalysis = getMaxDepthAndCountUsingTreeWalker(document.documentElement);
    const r = {
        title: document.title,
        description: document.head?.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
        href: document.location.href,
        html: document.documentElement?.outerHTML,
        text: document.body?.innerText,
        parsed: parsed,
        imgs: [],
        maxElemDepth: domAnalysis.maxDepth,
        elemCount: domAnalysis.elementCount,
    };
    if (document.baseURI !== r.href) {
        r.rebase = document.baseURI;
    }
    if (parsed && parsed.content) {
        const elem = document.createElement('div');
        elem.innerHTML = parsed.content;
        r.imgs = briefImgs(elem);
    } else {
        const allImgs = briefImgs();
        if (allImgs.length === 1) {
            r.imgs = allImgs;
        }
    }

    return r;
}
`;

@singleton()
export class PuppeteerControl extends AsyncService {

    _sn = 0;
    browser!: Browser;
    logger = this.globalLogger.child({ service: this.constructor.name });

    private __reqCapInterval?: NodeJS.Timeout;

    __loadedPage: Page[] = [];

    finalizerMap = new WeakMap<Page, ReturnType<typeof setTimeout>>();
    snMap = new WeakMap<Page, number>();
    livePages = new Set<Page>();
    lastPageCratedAt: number = 0;

    rpsCap: number = 500;
    lastReqSentAt: number = 0;
    requestDeferredQueue: Deferred<boolean>[] = [];

    circuitBreakerHosts: Set<string> = new Set();

    constructor(
        protected globalLogger: Logger,
    ) {
        super(...arguments);
        this.setMaxListeners(2 * Math.floor(os.totalmem() / (256 * 1024 * 1024)) + 1); 148 - 95;

        this.on('crippled', () => {
            this.__loadedPage.length = 0;
            this.livePages.clear();
        });
    }

    override async init() {
        if (this.__reqCapInterval) {
            clearInterval(this.__reqCapInterval);
            this.__reqCapInterval = undefined;
        }
        await this.dependencyReady();

        if (this.browser) {
            if (this.browser.connected) {
                await this.browser.close();
            } else {
                this.browser.process()?.kill('SIGKILL');
            }
        }
        this.browser = await puppeteer.launch({
            timeout: 10_000
        }).catch((err: any) => {
            this.logger.error(`Unknown firebase issue, just die fast.`, { err });
            process.nextTick(() => {
                this.emit('error', err);
                // process.exit(1);
            });
            return Promise.reject(err);
        });
        this.browser.once('disconnected', () => {
            this.logger.warn(`Browser disconnected`);
            this.emit('crippled');
            process.nextTick(() => this.serviceReady());
        });
        this.logger.info(`Browser launched: ${this.browser.process()?.pid}`);

        this.emit('ready');

        this.newPage().then((r) => this.__loadedPage.push(r));
    }

    @perNextTick()
    reqCapRoutine() {
        const now = Date.now();
        const numToPass = Math.round((now - this.lastReqSentAt) / 1000 * this.rpsCap);
        this.requestDeferredQueue.splice(0, numToPass).forEach((x) => x.resolve(true));
        if (numToPass) {
            this.lastReqSentAt = now;
        }
        if (!this.requestDeferredQueue.length) {
            if (this.__reqCapInterval) {
                clearInterval(this.__reqCapInterval);
                this.__reqCapInterval = undefined;
            }
        } else if (!this.__reqCapInterval) {
            this.__reqCapInterval = setInterval(() => this.reqCapRoutine(), 1000 / this.rpsCap).unref();
        }
    }

    async newPage() {
        await this.serviceReady();
        const dedicatedContext = await this.browser.createBrowserContext();
        const sn = this._sn++;
        let page;
        try {
            page = await dedicatedContext.newPage();
        } catch (err: any) {
            this.logger.warn(`Failed to create page ${sn}`, { err: marshalErrorLike(err) });
            throw new ServiceNodeResourceDrainError(`This specific worker node failed to open a new page, try again.`);
        }
        const preparations = [];

        // preparations.push(page.setUserAgent(`Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`));
        // preparations.push(page.setUserAgent(`Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`));
        preparations.push(page.setBypassCSP(true));
        preparations.push(page.setViewport({ width: 1024, height: 1024 }));
        preparations.push(page.exposeFunction('reportSnapshot', (snapshot: PageSnapshot) => {
            if (snapshot.href === 'about:blank') {
                return;
            }
            page.emit('snapshot', snapshot);
        }));
        preparations.push(page.evaluateOnNewDocument(SCRIPT_TO_INJECT_INTO_FRAME));
        preparations.push(page.setRequestInterception(true));

        await Promise.all(preparations);

        await page.goto('about:blank', { waitUntil: 'domcontentloaded' });

        const domainSet = new Set<string>();
        let reqCounter = 0;
        let t0: number | undefined;
        let halt = false;

        page.on('request', async (req) => {
            reqCounter++;
            if (halt) {
                return req.abort('blockedbyclient', 1000);
            }
            t0 ??= Date.now();
            const requestUrl = req.url();
            if (!requestUrl.startsWith('http:') && !requestUrl.startsWith('https:') && !requestUrl.startsWith('chrome-extension:') && requestUrl !== 'about:blank') {
                return req.abort('blockedbyclient', 1000);
            }
            const tldParsed = tldExtract(requestUrl);
            domainSet.add(tldParsed.domain);

            const parsedUrl = new URL(requestUrl);

            if (this.circuitBreakerHosts.has(parsedUrl.hostname.toLowerCase())) {
                page.emit('abuse', { url: requestUrl, page, sn, reason: `Abusive request: ${requestUrl}` });
                return req.abort('blockedbyclient', 1000);
            }

            if (
                parsedUrl.hostname === 'localhost' ||
                parsedUrl.hostname.startsWith('127.')
            ) {
                page.emit('abuse', { url: requestUrl, page, sn, reason: `Suspicious action: Request to localhost: ${requestUrl}` });

                return req.abort('blockedbyclient', 1000);
            }

            const dt = Math.ceil((Date.now() - t0) / 1000);
            const rps = reqCounter / dt;
            // console.log(`rps: ${rps}`);

            if (reqCounter > 1000) {
                if (rps > 60 || reqCounter > 2000) {
                    page.emit('abuse', { url: requestUrl, page, sn, reason: `DDoS attack suspected: Too many requests` });
                    halt = true;

                    return req.abort('blockedbyclient', 1000);
                }
            }

            if (domainSet.size > 200) {
                page.emit('abuse', { url: requestUrl, page, sn, reason: `DDoS attack suspected: Too many domains` });
                halt = true;

                return req.abort('blockedbyclient', 1000);
            }

            if (requestUrl.startsWith('http')) {
                const d = Defer();
                this.requestDeferredQueue.push(d);
                this.reqCapRoutine();
                await d.promise;
            }

            if (req.isInterceptResolutionHandled()) {
                return;
            };

            const continueArgs = req.continueRequestOverrides
                ? [req.continueRequestOverrides(), 0] as const
                : [];

            return req.continue(continueArgs[0], continueArgs[1]);
        });

        await page.evaluateOnNewDocument(`
let lastTextLength = 0;
const handlePageLoad = () => {
    if (window.haltSnapshot) {
        return;
    }
    const thisTextLength = (document.body.innerText || '').length;
    const deltaLength = Math.abs(thisTextLength - lastTextLength);
    if (10 * deltaLength < lastTextLength) {
        // Change is not significant
        return;
    }
    const r = giveSnapshot();
    window.reportSnapshot(r);
    lastTextLength = thisTextLength;
};
setInterval(handlePageLoad, 800);
document.addEventListener('readystatechange', handlePageLoad);
document.addEventListener('load', handlePageLoad);
`);

        this.snMap.set(page, sn);
        this.logger.info(`Page ${sn} created.`);
        this.lastPageCratedAt = Date.now();
        this.livePages.add(page);

        return page;
    }

    async getNextPage() {
        let thePage: Page | undefined;
        if (this.__loadedPage.length) {
            thePage = this.__loadedPage.shift();
            if (this.__loadedPage.length <= 1) {
                this.newPage()
                    .then((r) => this.__loadedPage.push(r))
                    .catch((err) => {
                        this.logger.warn(`Failed to load new page ahead of time`, { err: marshalErrorLike(err) });
                    });
            }
        }

        if (!thePage) {
            thePage = await this.newPage();
        }

        const timer = setTimeout(() => {
            this.logger.warn(`Page is not allowed to live past 5 minutes, ditching page ${this.snMap.get(thePage!)}...`);
            this.ditchPage(thePage!);
        }, 300 * 1000);

        this.finalizerMap.set(thePage, timer);

        return thePage;
    }

    async ditchPage(page: Page) {
        if (this.finalizerMap.has(page)) {
            clearTimeout(this.finalizerMap.get(page)!);
            this.finalizerMap.delete(page);
        }
        if (page.isClosed()) {
            return;
        }
        const sn = this.snMap.get(page);
        this.logger.info(`Closing page ${sn}`);
        this.livePages.delete(page);
        await Promise.race([
            (async () => {
                const ctx = page.browserContext();
                await page.close();
                await ctx.close();
            })(), delay(5000)
        ]).catch((err) => {
            this.logger.error(`Failed to destroy page ${sn}`, { err: marshalErrorLike(err) });
        });
    }

    async *scrap(parsedUrl: URL, options?: ScrappingOptions): AsyncGenerator<PageSnapshot | undefined> {
        // parsedUrl.search = '';
        const url = parsedUrl.toString();

        let snapshot: PageSnapshot | undefined;
        let screenshot: Buffer | undefined;
        let pageshot: Buffer | undefined;
        const pdfUrls: string[] = [];
        let navigationResponse: HTTPResponse | undefined;
        const page = await this.getNextPage();
        page.on('response', (resp) => {
            if (resp.request().isNavigationRequest()) {
                navigationResponse = resp;
            }
            if (!resp.ok()) {
                return;
            }
            const headers = resp.headers();
            const url = resp.url();
            const contentType = headers['content-type'];
            if (contentType?.toLowerCase().includes('application/pdf')) {
                pdfUrls.push(url);
            }
        });
        const sn = this.snMap.get(page);
        this.logger.info(`Page ${sn}: Scraping ${url}`, { url });

        this.logger.info(`Locale setting: ${options?.locale}`);
        if (options?.locale) {
            await page.setExtraHTTPHeaders({
                'Accept-Language': options?.locale
            });

            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, "language", {
                    get: function () {
                        return options?.locale;
                    }
                });
                Object.defineProperty(navigator, "languages", {
                    get: function () {
                        return [options?.locale];
                    }
                });
            });
        }

        if (options?.proxyUrl) {
            await page.useProxy(options.proxyUrl);
        }
        if (options?.cookies) {
            const mapped = options.cookies.map((x) => {
                if (x.domain || x.url) {
                    return x;
                }

                return { ...x, url: parsedUrl.toString() };
            });
            await page.setCookie(...mapped);
        }
        if (options?.overrideUserAgent) {
            await page.setUserAgent(options.overrideUserAgent);
        }

        let nextSnapshotDeferred = Defer();
        const crippleListener = () => nextSnapshotDeferred.reject(new ServiceCrashedError({ message: `Browser crashed, try again` }));
        this.once('crippled', crippleListener);
        nextSnapshotDeferred.promise.finally(() => {
            this.off('crippled', crippleListener);
        });
        let finalized = false;
        const hdl = (s: any) => {
            if (snapshot === s) {
                return;
            }
            snapshot = s;
            if (s?.maxElemDepth && s.maxElemDepth > 256) {
                return;
            }
            if (s?.elemCount && s.elemCount > 10_000) {
                return;
            }
            nextSnapshotDeferred.resolve(s);
            nextSnapshotDeferred = Defer();
            this.once('crippled', crippleListener);
            nextSnapshotDeferred.promise.finally(() => {
                this.off('crippled', crippleListener);
            });
        };
        page.on('snapshot', hdl);
        page.once('abuse', (event: any) => {
            this.emit('abuse', { ...event, url: parsedUrl });
            nextSnapshotDeferred.reject(
                new SecurityCompromiseError(`Abuse detected: ${event.reason}`)
            );
        });

        const timeout = options?.timeoutMs || 30_000;
        const goToOptions: GoToOptions = {
            waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
            timeout,
        };

        if (options?.referer) {
            goToOptions.referer = options.referer;
        }

        const gotoPromise = page.goto(url, goToOptions)
            .catch((err) => {
                if (err instanceof TimeoutError) {
                    this.logger.warn(`Page ${sn}: Browsing of ${url} timed out`, { err: marshalErrorLike(err) });
                    return new AssertionFailureError({
                        message: `Failed to goto ${url}: ${err}`,
                        cause: err,
                    });
                }
                if (err?.message?.startsWith('net::ERR_ABORTED')) {
                    if (pdfUrls.length) {
                        // Not throw for pdf mode.
                        return;
                    }
                }

                this.logger.warn(`Page ${sn}: Browsing of ${url} failed`, { err: marshalErrorLike(err) });
                return Promise.reject(new AssertionFailureError({
                    message: `Failed to goto ${url}: ${err}`,
                    cause: err,
                }));
            }).then(async (stuff) => {
                // This check is necessary because without snapshot, the condition of the page is unclear
                // Calling evaluate directly may stall the process.
                if (!snapshot) {
                    if (stuff instanceof Error) {
                        finalized = true;
                        throw stuff;
                    }
                }
                try {
                    const pSubFrameSnapshots = this.snapshotChildFrames(page);
                    snapshot = await page.evaluate('giveSnapshot(true)') as PageSnapshot;
                    screenshot = Buffer.from(await page.screenshot());
                    if (snapshot) {
                        snapshot.childFrames = await pSubFrameSnapshots;
                    }
                } catch (err: any) {
                    this.logger.warn(`Page ${sn}: Failed to finalize ${url}`, { err: marshalErrorLike(err) });
                    if (stuff instanceof Error) {
                        finalized = true;
                        throw stuff;
                    }
                }
                if (!snapshot?.html) {
                    if (stuff instanceof Error) {
                        finalized = true;
                        throw stuff;
                    }
                }
                try {
                    if ((!snapshot?.title || !snapshot?.parsed?.content) && !(snapshot?.pdfs?.length)) {
                        const salvaged = await this.salvage(url, page);
                        if (salvaged) {
                            const pSubFrameSnapshots = this.snapshotChildFrames(page);
                            snapshot = await page.evaluate('giveSnapshot(true)') as PageSnapshot;
                            screenshot = Buffer.from(await page.screenshot());
                            pageshot = Buffer.from(await page.screenshot({ fullPage: true }));
                            if (snapshot) {
                                snapshot.childFrames = await pSubFrameSnapshots;
                            }
                        }
                    }
                } catch (err: any) {
                    this.logger.warn(`Page ${sn}: Failed to salvage ${url}`, { err: marshalErrorLike(err) });
                }

                finalized = true;
                if (snapshot?.html) {
                    this.logger.info(`Page ${sn}: Snapshot of ${url} done`, { url, title: snapshot?.title, href: snapshot?.href });
                    this.emit(
                        'crawled',
                        {
                            ...snapshot,
                            status: navigationResponse?.status(),
                            statusText: navigationResponse?.statusText(),
                            pdfs: _.uniq(pdfUrls), screenshot, pageshot,
                        },
                        { ...options, url: parsedUrl }
                    );
                }
            });
        let waitForPromise: Promise<any> | undefined;
        if (options?.waitForSelector) {
            const t0 = Date.now();
            waitForPromise = nextSnapshotDeferred.promise.then(() => {
                const t1 = Date.now();
                const elapsed = t1 - t0;
                const remaining = timeout - elapsed;
                const thisTimeout = remaining > 100 ? remaining : 100;
                const p = (Array.isArray(options.waitForSelector) ?
                    Promise.all(options.waitForSelector.map((x) => page.waitForSelector(x, { timeout: thisTimeout }))) :
                    page.waitForSelector(options.waitForSelector!, { timeout: thisTimeout }))
                    .then(async () => {
                        const pSubFrameSnapshots = this.snapshotChildFrames(page);
                        snapshot = await page.evaluate('giveSnapshot(true)') as PageSnapshot;
                        screenshot = Buffer.from(await page.screenshot());
                        pageshot = Buffer.from(await page.screenshot({ fullPage: true }));
                        if (snapshot) {
                            snapshot.childFrames = await pSubFrameSnapshots;
                        }
                        finalized = true;
                    })
                    .catch((err) => {
                        this.logger.warn(`Page ${sn}: Failed to wait for selector ${options.waitForSelector}`, { err: marshalErrorLike(err) });
                        waitForPromise = undefined;
                    });
                return p as any;
            });
        }

        try {
            let lastHTML = snapshot?.html;
            while (true) {
                const ckpt = [nextSnapshotDeferred.promise, gotoPromise];
                if (waitForPromise) {
                    ckpt.push(waitForPromise);
                }
                if (options?.minIntervalMs) {
                    ckpt.push(delay(options.minIntervalMs));
                }
                let error;
                await Promise.race(ckpt).catch((err) => error = err);
                if (finalized && !error) {
                    if (!snapshot && !screenshot) {
                        if (error) {
                            throw error;
                        }
                        throw new AssertionFailureError(`Could not extract any meaningful content from the page`);
                    }
                    yield {
                        ...snapshot,
                        status: navigationResponse?.status(),
                        statusText: navigationResponse?.statusText(),
                        pdfs: _.uniq(pdfUrls), screenshot, pageshot
                    } as PageSnapshot;
                    break;
                }
                if (options?.favorScreenshot && snapshot?.title && snapshot?.html !== lastHTML) {
                    screenshot = Buffer.from(await page.screenshot());
                    pageshot = Buffer.from(await page.screenshot({ fullPage: true }));
                    lastHTML = snapshot.html;
                }
                if (snapshot || screenshot) {
                    yield {
                        ...snapshot,
                        status: navigationResponse?.status(),
                        statusText: navigationResponse?.statusText(),
                        pdfs: _.uniq(pdfUrls), screenshot, pageshot
                    } as PageSnapshot;
                }
                if (error) {
                    throw error;
                }
            }
        } finally {
            (waitForPromise ? Promise.allSettled([gotoPromise, waitForPromise]) : gotoPromise).finally(() => {
                page.off('snapshot', hdl);
                this.ditchPage(page);
            });
            nextSnapshotDeferred.resolve();
        }
    }

    async salvage(url: string, page: Page) {
        this.logger.info(`Salvaging ${url}`);
        const googleArchiveUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
        const resp = await fetch(googleArchiveUrl, {
            headers: {
                'User-Agent': `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)`
            }
        });
        resp.body?.cancel().catch(() => void 0);
        if (!resp.ok) {
            this.logger.warn(`No salvation found for url: ${url}`, { status: resp.status, url });
            return null;
        }

        await page.goto(googleArchiveUrl, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'], timeout: 15_000 }).catch((err) => {
            this.logger.warn(`Page salvation did not fully succeed.`, { err: marshalErrorLike(err) });
        });

        this.logger.info(`Salvation completed.`);

        return true;
    }

    async snapshotChildFrames(page: Page): Promise<PageSnapshot[]> {
        const childFrames = page.mainFrame().childFrames();
        const r = await Promise.all(childFrames.map(async (x) => {
            const thisUrl = x.url();
            if (!thisUrl || thisUrl === 'about:blank') {
                return undefined;
            }
            try {
                await x.evaluate(SCRIPT_TO_INJECT_INTO_FRAME);

                return await x.evaluate(`giveSnapshot()`);
            } catch (err) {
                this.logger.warn(`Failed to snapshot child frame ${thisUrl}`, { err });
                return undefined;
            }
        })) as PageSnapshot[];

        return r.filter(Boolean);
    }

}

const puppeteerControl = container.resolve(PuppeteerControl);

export default puppeteerControl;
