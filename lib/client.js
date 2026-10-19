window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-auth',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React

    const ROUTE_PREFIX = '/api/dsh-workbuddy-auth'
    const STATUS_ROUTE = `${ROUTE_PREFIX}/status`
    const ACTION_ROUTES = Object.freeze({
      test: `${ROUTE_PREFIX}/connection/test`,
      refresh: `${ROUTE_PREFIX}/credential/refresh`,
      reload: `${ROUTE_PREFIX}/credential/reload`,
    })
    const SOURCES_ROUTE = `${ROUTE_PREFIX}/credentials/sources`
    const ACTIVE_ROUTE = `${ROUTE_PREFIX}/credentials/active`
    const LOGIN_ROUTE = `${ROUTE_PREFIX}/accounts/login`
    const LOGIN_STATUS_ROUTE = `${ROUTE_PREFIX}/accounts/login/status`
    const CHECKIN_SETTINGS_ROUTE = `${ROUTE_PREFIX}/checkin/settings`
    const CHECKIN_NOW_ROUTE = `${ROUTE_PREFIX}/checkin/now`
    // 第二订阅点（智谱清言 Agent）的独立路由族，前缀刻意与 WorkBuddy 各走一边。
    const AGENTMORE_PREFIX = `${ROUTE_PREFIX}/agentmore`
    const AGENTMORE_ROUTES = Object.freeze({
      status: `${AGENTMORE_PREFIX}/status`,
      login: `${AGENTMORE_PREFIX}/login`,
      loginStatus: `${AGENTMORE_PREFIX}/login/status`,
      loginCancel: `${AGENTMORE_PREFIX}/login/cancel`,
      accounts: `${AGENTMORE_PREFIX}/accounts`,
      accountActive: `${AGENTMORE_PREFIX}/accounts/active`,
      accountRemove: `${AGENTMORE_PREFIX}/accounts/remove`,
      credits: `${AGENTMORE_PREFIX}/credits`,
      models: `${AGENTMORE_PREFIX}/models`,
      modelsRefresh: `${AGENTMORE_PREFIX}/models/refresh`,
    })
    // 浏览器登录由**宿主**自己起（不是把授权链接交给用户），因此客户端只需轮询状态。
    const AGENTMORE_LOGIN_STATUSES = ['idle', 'running', 'complete', 'error', 'cancelled']
    const AGENTMORE_POLL_INTERVAL_MS = 1500
    // Host 侧流程上限 600s（要等用户真的把账号登进去），留出余量。
    const AGENTMORE_MAX_POLLS = 420
    const LOGIN_STATUSES = ['idle', 'pending', 'complete', 'error']
    const LOGIN_POLL_INTERVAL_MS = 1500
    // Host 侧登录流程最长 300s；上界留出余量，避免页面无限轮询。
    const LOGIN_MAX_POLLS = 220
    const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' })

    // ── 订阅点官方图标（内联 data URI）─────────────────────────────────────────
    //
    // 需求：每个订阅点显示自己的官方标识（截图里原本是 "WB" / "GLM" 两个文字方块）。
    //
    // 为什么内联而不是外链：
    //   * Web 前端跑在 `dsh-app://` 与 http://127.0.0.1 下，外链图片要额外的域名许可，
    //     且离线/弱网时会变成破图；内联零请求。
    //   * CSP 若收紧到不含远程 img-src，外链会静默失效，而内联的 data: URI 不受影响。
    //
    // 来源（逐字节取自官方站点，未做任何重绘或改色）：
    //   * WORKBUDDY_ICON ← https://www.workbuddy.ai/ 的 `<link rel="icon">`：
    //     download.codebuddy.ai/web/workbuddy/<hash>/assets/logo.svg（40×40 圆角渐变 + 白色双圆点）
    //   * AGENTMORE_ICON ← https://chatglm.cn/favicon.ico（实为 64×64 PNG，智谱蓝色圆环）
    const WORKBUDDY_ICON = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzU0Ml8zMzcwKSI+CjxyZWN0IHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgcng9IjIwIiBmaWxsPSJ1cmwoI3BhaW50MF9saW5lYXJfNTQyXzMzNzApIi8+CjxnIGZpbHRlcj0idXJsKCNmaWx0ZXIwX2ZfNTQyXzMzNzApIj4KPGNpcmNsZSBjeD0iMzEuMzQxMSIgY3k9IjQzLjYxODMiIHI9IjEyLjg3MDQiIGZpbGw9IiNGRkUzNTUiIGZpbGwtb3BhY2l0eT0iMC40OSIgc3R5bGU9ImZpbGw6I0ZGRTM1NTtmaWxsOmNvbG9yKGRpc3BsYXktcDMgMS4wMDAwIDAuODg5MSAwLjMzNDgpO2ZpbGwtb3BhY2l0eTowLjQ5OyIvPgo8L2c+CjxwYXRoIGQ9Ik0yOC41OTMxIDMuMTI3NjJDMjguOTg1MyAyLjc3NTg1IDI5LjAwOTEgMi43NjIyNiAyOS4yOTY4IDIuNzQ0OTlDMjkuNzYyOCAyLjcxMDk2IDMwLjE4OTQgMi45MzQ4OCAzMC45MTYgMy41OTYzNEMzMi42MTMyIDUuMTM4NzUgMzQuOTc2OSA4LjMwOTA0IDM2LjQ0NjIgMTEuMDE2OEwzNy4wMTM4IDEyLjA2ODJMMzcuODE1NiAxMi40NjY4QzM4LjU4OTYgMTIuODU3OSAzOS44NTkzIDEzLjY1OTMgNDAuMzg5OCAxNC4wODk1QzQwLjYyOTcgMTQuMjg3OCA0MC42NjM4IDE0LjI5MjUgNDAuOTEzMyAxNC4xOTU0QzQyLjAzODggMTMuNzU3MiA0My42NTA2IDE0LjMzODIgNDUuMDcyNyAxNS43MDI0QzQ2LjM1MjkgMTYuOTI5NCA0Ny41Nzk0IDE5LjAyNiA0OC4wNDkxIDIwLjc3NTdDNDguMTE3NyAyMS4wNTc0IDQ4LjIwODcgMjEuNjYyOCA0OC4yNDE5IDIyLjExMzRDNDguMzQ5IDIzLjY5NjQgNDcuODQxNCAyNC45NjA4IDQ2Ljg2MzcgMjUuNTMzMUM0Ni42NjQgMjUuNjQ4NCA0Ni42NTA1IDI1LjY3OTUgNDYuNjU2MSAyNi4xNzc0QzQ2LjcwMTEgMjguNTQ4MSA0Ni4wNjIxIDMwLjkxNDQgNDQuNzc4NSAzMy4yMjIxQzQzLjMyOTMgMzUuODEzMyA0MC43NDg5IDM4LjQ5NDUgMzcuMjU2NiA0MS4wMTk5QzM1LjM4MTMgNDIuMzg0NiAzMC45NDQ1IDQ0Ljk3MDEgMjguOTM4MiA0NS44Nzc4QzI0LjEzMjQgNDguMDQxNCAyMC4yNzk0IDQ4Ljg3MDkgMTYuOTMyOSA0OC40NjA5QzE0LjkzNjggNDguMjE5IDEyLjY3NjkgNDcuNDQgMTEuMzQgNDYuNTM1NUMxMC45ODg1IDQ2LjI5MjUgMTAuOTMyNSA0Ni4yNzc0IDEwLjY2MzcgNDYuMzU0M0M5LjIzMjcgNDYuNzY1MSA3LjM1ODY3IDQ1LjkyMDcgNS43NjY1OSA0NC4xNTM1QzUuMTMxNjUgNDMuNDQ3MSA0LjEwNjUgNDEuNzEyNyAzLjc3NDA0IDQwLjc4NDNDMy4wMDU0IDM4LjYxMTggMy4xNTg1MiAzNi42NTA2IDQuMTgyMzYgMzUuNDc5OUM0LjQ0NjcxIDM1LjE3ODUgNC40NTUxMSAzNS4xNjU4IDQuMzk3MzUgMzQuNjU4OUM0LjMwMTk1IDMzLjgyODkgNC4yNTgzNyAzMi42MDA4IDQuMzAxOTIgMzEuODA4TDQuMzM2NjYgMzEuMDY3NEwzLjIyNTAyIDI5LjEwMUMxLjUwMzMgMjYuMDM3NSAwLjQwOTMyNSAyMy40NjQ1IC0wLjAxMjU2MyAyMS40OTkyQy0wLjIzNTIxOSAyMC40MjE4IC0wLjIyMTE5MyAxOS45NDM2IDAuMDUyMjE4NiAxOS41ODk5QzAuMjE4NzEgMTkuMzc2MyAwLjc2NDkyOCAxOS4xNTQ1IDEuNDIzMjIgMTkuMDMyOUMzLjA4MDQxIDE4Ljc0MiA2LjY5NDY2IDE5LjAwNTYgMTAuNzE1NSAxOS43MTU1TDExLjEzMjkgMTkuNzg4TDEyLjA1MTEgMTguOTc2QzEzLjU3NDcgMTcuNjI2NCAxNC41ODcgMTYuODY5NiAxNi40NTMxIDE1LjcwNkMxOC4zOTgxIDE0LjQ4OTEgMjAuNTkyOSAxMy40ODc3IDIzLjA2NDggMTIuNjk1TDIzLjg1NzcgMTIuNDQxNEwyNC4yOTM5IDExLjI5NjRDMjUuODU0NyA3LjE3NjE1IDI3LjQ1MzMgNC4xMzg0NCAyOC41OTMxIDMuMTI3NjJaTTE1LjUxODIgMjQuMjQzQzEzLjc1NDIgMjUuMjYxNSAxMi44NzE4IDI1Ljc3MDYgMTIuMjIzNiAyNi4zNDEzQzkuNTk4OTMgMjguNjUyNiA4LjYxODExIDMyLjMxMzQgOS43MzU0NSAzNS42Mjc0QzEwLjAxMTQgMzYuNDQ1NyAxMC41MjAxIDM3LjMyODMgMTEuNTM4NiAzOS4wOTIzQzEyLjU1NzEgNDAuODU2NCAxMy4wNjcxIDQxLjczODMgMTMuNjM3OCA0Mi4zODY0QzE1Ljk0OTEgNDUuMDExMiAxOS42MTAzIDQ1Ljk5MjkgMjIuOTI0MyA0NC44NzU1QzIzLjc0MjYgNDQuNTk5NSAyNC42MjQ5IDQ0LjA4OTkgMjYuMzg4OCA0My4wNzE0TDM2LjUzNzUgMzcuMjEyMUMzOC4zMDE2IDM2LjE5MzYgMzkuMTg0IDM1LjY4NDUgMzkuODMyMSAzNS4xMTM3QzQyLjQ1NjggMzIuODAyNCA0My40MzczIDI5LjE0MDkgNDIuMzE5OCAyNS44MjY5QzQyLjA0MzggMjUuMDA4NiA0MS41MzQyIDI0LjEyNjQgNDAuNTE1OCAyMi4zNjI0QzM5LjQ5NzMgMjAuNTk4MyAzOC45ODgyIDE5LjcxNTkgMzguNDE3NSAxOS4wNjc4QzM2LjEwNjIgMTYuNDQzMiAzMi40NDU0IDE1LjQ2MjIgMjkuMTMxNCAxNi41Nzk2QzI4LjMxMzEgMTYuODU1NiAyNy40MzEgMTcuMzY1MSAyNS42NjY5IDE4LjM4MzZMMTUuNTE4MiAyNC4yNDNaIiBmaWxsPSJ1cmwoI3BhaW50MV9saW5lYXJfNTQyXzMzNzApIi8+CjxyZWN0IHg9IjE2LjQ5NjEiIHk9IjMxLjMzNDQiIHdpZHRoPSI0LjAwOTA0IiBoZWlnaHQ9IjguMzI2NDYiIHJ4PSIyLjAwNDUyIiB0cmFuc2Zvcm09InJvdGF0ZSgtMzAgMTYuNDk2MSAzMS4zMzQ0KSIgZmlsbD0id2hpdGUiIHN0eWxlPSJmaWxsOndoaXRlO2ZpbGwtb3BhY2l0eToxOyIvPgo8cmVjdCB4PSIyNy4zMTI1IiB5PSIyNS4wODk0IiB3aWR0aD0iNC4wMDkwNCIgaGVpZ2h0PSI4LjMyNjQ2IiByeD0iMi4wMDQ1MiIgdHJhbnNmb3JtPSJyb3RhdGUoLTMwIDI3LjMxMjUgMjUuMDg5NCkiIGZpbGw9IndoaXRlIiBzdHlsZT0iZmlsbDp3aGl0ZTtmaWxsLW9wYWNpdHk6MTsiLz4KPC9nPgo8ZGVmcz4KPGZpbHRlciBpZD0iZmlsdGVyMF9mXzU0Ml8zMzcwIiB4PSI3LjQ3MDMzIiB5PSIxOS43NDc1IiB3aWR0aD0iNDcuNzQyIiBoZWlnaHQ9IjQ3Ljc0MTYiIGZpbHRlclVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgY29sb3ItaW50ZXJwb2xhdGlvbi1maWx0ZXJzPSJzUkdCIj4KPGZlRmxvb2QgZmxvb2Qtb3BhY2l0eT0iMCIgcmVzdWx0PSJCYWNrZ3JvdW5kSW1hZ2VGaXgiLz4KPGZlQmxlbmQgbW9kZT0ibm9ybWFsIiBpbj0iU291cmNlR3JhcGhpYyIgaW4yPSJCYWNrZ3JvdW5kSW1hZ2VGaXgiIHJlc3VsdD0ic2hhcGUiLz4KPGZlR2F1c3NpYW5CbHVyIHN0ZERldmlhdGlvbj0iNS41MDAxOSIgcmVzdWx0PSJlZmZlY3QxX2ZvcmVncm91bmRCbHVyXzU0Ml8zMzcwIi8+CjwvZmlsdGVyPgo8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50MF9saW5lYXJfNTQyXzMzNzAiIHgxPSIyMCIgeTE9IjAiIHgyPSIyMCIgeTI9IjQwIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiMwRUM4QTkiIHN0eWxlPSJzdG9wLWNvbG9yOiMwRUM4QTk7c3RvcC1jb2xvcjpjb2xvcihkaXNwbGF5LXAzIDAuMDU2NSAwLjc4MzcgMC42NjI1KTtzdG9wLW9wYWNpdHk6MTsiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDFDODg2IiBzdHlsZT0ic3RvcC1jb2xvcjojMDFDODg2O3N0b3AtY29sb3I6Y29sb3IoZGlzcGxheS1wMyAwLjAwMjEgMC43ODU4IDAuNTI0Nik7c3RvcC1vcGFjaXR5OjE7Ii8+CjwvbGluZWFyR3JhZGllbnQ+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQxX2xpbmVhcl81NDJfMzM3MCIgeDE9IjE0LjY2NDIiIHkxPSIxMS4wNzgzIiB4Mj0iMzMuMzc2MiIgeTI9IjQzLjQ4ODUiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0id2hpdGUiIHN0b3Atb3BhY2l0eT0iMC44IiBzdHlsZT0ic3RvcC1jb2xvcjp3aGl0ZTtzdG9wLW9wYWNpdHk6MC44OyIvPgo8c3RvcCBvZmZzZXQ9IjAuNDM3Njg5IiBzdG9wLWNvbG9yPSJ3aGl0ZSIgc3R5bGU9InN0b3AtY29sb3I6d2hpdGU7c3RvcC1vcGFjaXR5OjE7Ii8+CjwvbGluZWFyR3JhZGllbnQ+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNTQyXzMzNzAiPgo8cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSIyMCIgZmlsbD0id2hpdGUiIHN0eWxlPSJmaWxsOndoaXRlO2ZpbGwtb3BhY2l0eToxOyIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo='
    const AGENTMORE_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAg+SURBVHgB3VtrbFRFFD673XbbuoBY1EJCUy2gP2hK9YcJJTwSCaYEef0AKxGqhGCaqJAISgImYoz1BxETkOADIabKD+WVkvhIpE1LjIm0DcQUgXStQZCIgta+drvrfHf20nt3Z2bn3n2Vfsnkbne7j+87Z86cOWeuhzQQjUYXsstyNnAtZ+NeGpu4xUZnbJzweDxnKBUw4hvY6InevehhY4OKo0dCvJxdjrExh8YHgmwsYh4RjH/BG/8EI7+eXTpo/JAHytnoYNxWxL9g84DYPxyj8Y0NzBMOm3/cESDm9rB81gPc7b5obPDHkwIeNojKSr2UASBQVpvTwSpAD3FXyShAsK1zhNq7Ruj8lQidvxwxnpOhcobXEKKmKo+W1uSlS5ROJkA1HhgCxCLlIcoQQLDp6zCdbg8b5FMBBNm8uoDqlvgoRdQzET41BciI9UH2wFcham4LU7oBT9i+PiUhgkyAhzxRnuR8T2kEiDceGU7Z2jqAAG83+I244QKLIMB77MHLlAb0Xo9Qw7tDWSFuBbzh1J5CN/FhL95RRWnAgS9DNH/TQNbJAxB+2dZB4+oQC+ABf1MKS59bq8+bk0ezK7xUWZHHHntjS9+oGyNw9l6PGqvE6bNhrTiCANl6sJgc4BYEiJJLNLOo3tA4pFzGrADp2rk+qnvK53jOQmisJJ+zobI0AuNrbOjCtQCNh4fpHTZ08AwLVHVL8g0BUgXIr9s1aHiGDF1NxdrxwJUAuuRBeN82f0YyOoggmxZLa3z02e5C0oFjAXTIgzCIp8PiMmDaIejKpkPw5D1a08yRADrkN6/ON+ag9cuv/Un0Sy/R9ZtEv7PHfQNs9BP9229/79QpRIEiomnsOnM6e8zi2awy+Xch8C7bOiB8DbnBi+y3JIO2ADrkzS8F4Va2rTp3kY94ok4woZiLsYBl7tWPJAoCAUQrELzv1J4iSgYtARDt1+0clL4Oaze9VUQ/93jvkM4U4CVL52Ke88cfsPxjx74hEv0mTINkSCoA5hjmmmypy/d5afnCQgpe86ZkaTeACJUPR6j+TfEX66wGSQWoquuXBhqQnz610LjmEhd7+oTPIylCcqSC8lWkt6qkY9qDuScP5OeLf4NOgibdS4K4Kug9UOKnwgJ98pivs1gwKy3hUT4gyFixMmCVwGphrBy/UcYhFQBRX6bgpICPJk9ULzGI3rUsWD3+KI/eExyl6ByIKZeYCC3nmDt3clFECIUikt/pMg+A9TH3RUg27x9jZDcu59d0A6tLczsfJoaGIxS8Kv6tOsmQ0AMaFa4/ZXKBkDwi8sanuatnChDVEJh9z0cnuRChsNz6Oh4gFKCtS/yhhX4vTQzY3wLCO5/PjMVlML8TQqzaJt4PmNHfnDYywySYskmx3bz/Pr/t7zWLiY68kV3yVoBU/6D4t86v5oaCALs/kX9GggCnJTssuH1x4ejmBvN8y1p3wS1dUBmrJrYRQxBF7PjiW/FnJAjQ1iWu7EyeNBr1QR7ul2vIYhWyv7mVnFpLB3/u45PiPYlNAFWTIlDMFTWDXa6hsv7iJ3hFCO5v7ktA3rp6mLAJ0PuHPOXFwJwbC+QB1Ur10hpOK35T1tqR+L8JHiCC38//LdPLnC5AXmZ9lN8wBWB9LJVWQJD4ZMruAZIPLfDx9TRX0d6KZCm6WRBF0BNljvFeoZXMe70eg3yurW/W/2VARdjc/vZJtuZKD1Ah1+QRnFEIlXkpiFvL4bJS2rWb9r+1BMBmY2oJ5RToP6hK4WiNWRHQzE9sAlTOEFdxB9mGI165bAGWb2gcNMpyMlhd34Rs5xgPW2JfVirePGDH1f0r8gNXHVjX0GmC1LIegKgTJKslxHuyTbZ5VfI6/o8XQlmt+YE0Ap6KPKy+f7tf+NoliQAoylhhEwDbR1kz46/bIdaXc91GdATeae5XluPMlrhoy4uMTzYFZsYFx4QgCJcSIRKJ0vtHh7Tnlhtwqw/Q64IytxXJzgPEJ0AmREt5wifgxIWskHD1Rphe2aPXEHUCBDrU9mH1ZG32pORPyK2PfUw8Ej4F5Lc/J28vf/PDsHI9dgKQBXGU39DgSAZMz9aDRUryMusbDRWBANK+gKzlZAJCwVvQC3TS/YVwze0jjk+MJev7q8gDqCA5EsDJsRNYprLCS7Mr8hKWUpzyuP1flC5cGWGEI449J1mnGSsTyB/9Tv4ZIA4BRFB2hsygpHsCJN0QdZqtONfNyl2H1EkPXH//q/JUXqs36PIAkmvA2ohDMqtf6uXu3tKh/hyU61CzVO1jtLrDIL9mxzB1B9N/4NEKFXGjSRIjrtN9Bvn923hrXQXt8wFws2d3henC5WFpLd4NzORr86rEM0RmSQsD1RzdTDSZ21vh6Jgc9tgfMgscPBamf/pC1D/g7kwg6gvoMcws89GmFTzvAFkQxOkR8zSJm9QbyQ4Cnub23Tgm5/jmCKSacMWrN6KsLj9CA2xgx4hscSQy2qszu7b5rKKE4S/IY8NeXk8X4PIvsGr12icdve2M66OysFjzWb4E5Rpo0KBe6aJHsTflw9Jm8VFUcMwkzO7z2sUpVasWpfW4vNm5zeQZIcxxHJiqrUm5K8WPy+NRum+YQPDqYCL81M2vqRx0gHXNrvD86rS24kZvmADcBEMnQIECU8SM9qISG6o1IGieDywtyVjv0bA+HoyJm6ayDNtNU3e2cbEnttD4R731BkrbPhZzgl1WEldpvAGcQP649UnVrbNYGstpfAA3U6/UunUWwD/GgkQ98ftu71YEiVu9WkQe0Cr0x5Il3FaL+4uwUozl2+eDbLSwcVzn9vn/AWPIqLtnLYy9AAAAAElFTkSuQmCC'

    const styles = `
      .wb-settings { color: var(--dsw-alias-label-primary, inherit); max-width: 720px; overflow-wrap: anywhere; }
      .wb-settings * { box-sizing: border-box; }
      .wb-settings__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-bottom: 16px; }
      .wb-settings__title { margin: 0; font: inherit; font-size: 1.08rem; font-weight: 650; letter-spacing: -0.01em; }
      .wb-settings__lede, .wb-settings__muted { margin: 0; color: var(--dsw-alias-label-tertiary, currentColor); font-size: .875rem; line-height: 1.55; }
      .wb-settings__section { border-top: .5px solid var(--dsw-alias-border-l3, currentColor); padding: 16px 0; }
      .wb-settings__section-title { margin: 0 0 10px; font: inherit; font-size: .78rem; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, currentColor); }
      .wb-settings__rows { display: grid; grid-template-columns: minmax(7.5rem, .7fr) minmax(0, 1.3fr); gap: 8px 18px; margin: 0; }
      .wb-settings__rows dt, .wb-settings__rows dd { margin: 0; min-width: 0; font-size: .9rem; line-height: 1.5; }
      .wb-settings__rows dt { color: var(--dsw-alias-label-tertiary, currentColor); }
      .wb-settings__rows dd { text-align: right; font-variant-numeric: tabular-nums; }
      .wb-settings__credits { display: flex; align-items: end; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
      .wb-settings__balance { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
      .wb-settings__diamond { color: var(--dsw-alias-state-business-primary, currentColor); opacity: .78; font-size: 1rem; line-height: 1; }
      .wb-settings__remaining { font-size: clamp(1.45rem, 4vw, 1.9rem); line-height: 1; font-weight: 680; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
      .wb-settings__remaining-label { color: var(--dsw-alias-label-tertiary, currentColor); font-size: .75rem; }
      .wb-settings__credit-meta { display: flex; gap: 18px; flex-wrap: wrap; }
      .wb-settings__metric { display: grid; gap: 2px; min-width: 4.5rem; }
      .wb-settings__metric-label { color: var(--dsw-alias-label-tertiary, currentColor); font-size: .72rem; }
      .wb-settings__metric-value { font-size: .9rem; font-variant-numeric: tabular-nums; }
      .wb-settings__credit-note { width: 100%; margin-top: 2px; }
      .wb-settings__alert { margin: 0 0 12px; padding: 10px 12px; border-left: 3px solid currentColor; background: var(--dsw-alias-bg-layer-1, transparent); font-size: .86rem; line-height: 1.5; }
      .wb-settings__alert--error { color: var(--dsw-alias-state-error-primary, currentColor); }
      .wb-settings__actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .wb-settings__button { appearance: none; min-height: 34px; max-width: 100%; padding: 6px 12px; border: .5px solid var(--dsw-alias-border-l3, currentColor); border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: .86rem; line-height: 1.2; cursor: pointer; }
      .wb-settings__button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
      .wb-settings__button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
      .wb-settings__button:disabled { cursor: not-allowed; opacity: .48; }
      .wb-settings__risk { margin-top: 10px; }
      .wb-settings__guide { margin: 10px 0 0; font-size: .86rem; line-height: 1.55; }
      .wb-settings__link { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
      .wb-settings__button[data-wb-selected="true"] { border-color: currentColor; font-weight: 600; }
      .wb-settings__code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: .82em; }
      .wb-settings__model-choice { display: flex; align-items: center; gap: 9px; min-height: 34px; font-size: .9rem; }
      .wb-settings__model-choice input, .wb-settings__model-row input { flex: 0 0 auto; accent-color: var(--dsw-alias-state-business-primary, auto); }
      .wb-settings__model-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
      .wb-settings__model-toolbar .wb-settings__actions { display: flex; gap: 2px; }
      .wb-settings__model-toolbar .wb-settings__button { border-color: transparent; padding: 4px 8px; background: transparent; color: var(--dsw-alias-state-business-primary, inherit); }
      .wb-settings__model-count { font-size: .78rem; color: var(--dsw-alias-label-secondary, inherit); font-variant-numeric: tabular-nums; }
      .wb-settings__model-list { display: grid; gap: 2px; margin-top: 4px; }
      .wb-settings__model-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
      .wb-settings__model-row:hover, .wb-settings__model-row:focus-within { background: var(--dsw-alias-bg-layer-hover, color-mix(in srgb, currentColor 5%, transparent)); }
      .wb-settings__model-row:has(input:checked) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3e9cb3) 12%, transparent); }
      .wb-settings__model-copy { display: grid; gap: 2px; min-width: 0; flex: 1; }
      .wb-settings__model-name { font-size: .86rem; font-weight: 600; overflow-wrap: anywhere; }
      .wb-settings__model-meta { font-size: .73rem; line-height: 1.35; color: var(--dsw-alias-label-secondary, inherit); overflow-wrap: anywhere; }
      .wb-settings__enhancements { border-top: .5px solid var(--dsw-alias-border-l3, currentColor); margin-top: 20px; padding-top: 20px; }
      .wb-settings__enhancements h5 { margin: 20px 0 8px; font-size: .88rem; font-weight: 600; }
      .wb-settings__model-field { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; font-size: .86rem; }
      .wb-settings__model-field > span { flex: 1 1 14rem; }
      .wb-settings__model-field small { display: block; margin-top: 4px; color: var(--dsw-alias-label-secondary, inherit); font-size: .76rem; font-weight: 400; }
      .wb-settings__model-input { min-height: 34px; min-width: 0; width: 10rem; max-width: 100%; padding: 6px 9px; border: .5px solid var(--dsw-alias-border-l3, currentColor); border-radius: 6px; color: inherit; background: var(--dsw-alias-bg-layer-1, transparent); font: inherit; }
      .wb-settings__model-input::placeholder { color: var(--dsw-alias-label-secondary, currentColor); }
      .wb-settings__model-input:disabled { opacity: .48; }
      .wb-settings__model-input:focus-visible, .wb-settings__model-choice input:focus-visible, .wb-settings__model-row input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
      .wb-settings__model-reset { display: flex; justify-content: flex-end; margin-top: 16px; }
      @media (max-width: 560px) {
        .wb-settings__model-input { width: 100%; }
        .wb-settings__rows { grid-template-columns: minmax(0, 1fr); gap: 2px; }
        .wb-settings__rows dd { text-align: left; margin-bottom: 8px; }
        .wb-settings__credits { align-items: flex-start; }
        .wb-settings__credit-meta { width: 100%; }
        .wb-settings__actions { display: grid; grid-template-columns: minmax(0, 1fr); }
        .wb-settings__button { width: 100%; }
      }
      @media (prefers-reduced-motion: reduce) {
        .wb-settings *, .wb-settings *::before, .wb-settings *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
      }
      /* 订阅点总览（单一入口）：每张卡是一整块可点区域，因此用 <button> 承载语义与键盘可达性，
         视觉上再抹平按钮默认样式。这里只做「看起来像卡片」，交互仍是原生 button。 */
      .wb-settings__hub-list { display: grid; gap: 12px; margin-top: 16px; }
      .wb-settings__hub-card { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-neutral-default, rgba(128,128,128,.22)); border-radius: 10px; background: var(--dsw-alias-bg-elevated, transparent); color: inherit; font: inherit; cursor: pointer; }
      .wb-settings__hub-card:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, currentColor); }
      .wb-settings__hub-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
      .wb-settings__hub-card:disabled { opacity: .55; cursor: progress; }
      .wb-settings__hub-tile { display: grid; place-items: center; flex: none; width: 38px; height: 38px; border-radius: 9px; overflow: hidden; background: var(--dsw-alias-bg-neutral-weak, rgba(128,128,128,.14)); }
      .wb-settings__hub-tile img { display: block; width: 100%; height: 100%; object-fit: contain; }
      .wb-settings__hub-copy { flex: 1; min-width: 0; }
      .wb-settings__hub-name { display: block; font-weight: 600; }
      .wb-settings__hub-line { display: block; font-size: .86em; line-height: 1.5; color: var(--dsw-alias-fg-neutral-weak, #6b7280); margin-top: 2px; }
      .wb-settings__hub-chevron { flex: none; color: var(--dsw-alias-fg-neutral-weak, #6b7280); }
      .wb-settings__hub-back { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; opacity: .78; }
      .wb-settings__hub-back:hover { opacity: 1; }
      .wb-settings__hub-back:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
      /* 详情页页眉：图标 + 名称 + 一行说明。详情页**不再**重复渲染订阅点名字 ——
         那张卡本身已经有 <h3>，页眉再来一遍就是同名两行（用户实测反馈的重复标题）。 */
      .wb-settings__detail-head { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
      .wb-settings__detail-mark { flex: none; width: 28px; height: 28px; border-radius: 7px; overflow: hidden; }
      .wb-settings__detail-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
      .wb-settings__detail-title { margin: 0; font: inherit; font-size: 1.02rem; font-weight: 650; letter-spacing: -.01em; }
      .wb-settings__detail-line { margin: 1px 0 0; font-size: .82rem; line-height: 1.4; color: var(--dsw-alias-label-tertiary, currentColor); }
      @media (max-width: 560px) {
        .wb-settings__hub-card { padding: 12px; gap: 10px; }
      }
    `

    function finiteNumber(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number : 0
    }

    /**
     * 可空数字：`null` / `undefined` / `''` 一律保留为 `null`，其余走 `finiteNumber`。
     *
     * 为什么不直接用 `finiteNumber`：`Number(null)` 是 `0`，会把「服务端没给余额」
     * 折叠成「余额真的是 0」。前者要显示「未取到」，后者要显示 `0`，两者语义相反。
     */
    function nullableNumber(value) {
      if (value === null || value === undefined || value === '') return null
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }

    function shortText(value) {
      return typeof value === 'string' ? value.slice(0, 160) : ''
    }

    /**
     * 服务端给的 hint 是客户端**唯一**会整段展示的非固定文案，因此在边界上再设一道形状闸门：
     * 含有一长串无空格的字面（>=24 个 [A-Za-z0-9_-]）即视为可能夹带令牌，整条丢弃。
     * 本插件自己的 hint 全是中文句子，最长连写是 `codebuddy` / `{$wbEncrypted}`，
     * 因此这条规则不会误伤真实文案，却能让「上游某天把令牌塞进 hint」到不了用户眼前。
     */
    function safeHint(value) {
      const text = shortText(value)
      if (text === '') return ''
      return /[A-Za-z0-9_-]{24,}/.test(text) ? '' : text
    }

    // 只有这份最小 DTO 能进入组件 state；响应中的其它键（尤其令牌）在请求边界被丢弃。
    /**
     * 签到摘要白名单：只留六个安全键，计数一律归一成非负整数。
     * Host 侧已做过一次同样的投影，这里是前端侧的防御（响应体永远不信任）。
     */
    function normalizeCheckin(value) {
      const count = (raw) => (Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Math.floor(Number(raw)) : 0)
      return {
        enabled: value?.enabled === true,
        totalAccounts: count(value?.totalAccounts),
        doneToday: count(value?.doneToday),
        skippedToday: count(value?.skippedToday),
        failedToday: count(value?.failedToday),
        lastRunAt: count(value?.lastRunAt),
      }
    }

    // 余额失败枚举与宿主 status.mjs 的白名单保持同一份语义：未知值一律 unavailable。
    const CREDIT_ERRORS = ['unavailable', 'auth-rejected', 'request-failed', 'upstream-invalid']

    function normalizeStatus(value) {
      const account = value?.account
      const token = value?.token
      const state = value?.state
      const credits = value?.credits
      const accounts = value?.accounts
      const checkin = value?.checkin
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        account: {
          nickname: shortText(account?.nickname),
          uidTail: shortText(account?.uidTail),
          phoneMasked: shortText(account?.phoneMasked),
        },
        credits: credits?.ok === true
          ? {
              ok: true,
              remaining: finiteNumber(credits.remaining),
              total: finiteNumber(credits.total),
              used: finiteNumber(credits.used),
              fetchedAt: finiteNumber(credits.fetchedAt),
              stale: credits.stale === true,
            }
          : { ok: false, error: credits?.ok === false && CREDIT_ERRORS.includes(credits.error) ? credits.error : 'unavailable' },
        token: {
          accessExpiresAt: finiteNumber(token?.accessExpiresAt),
          accessDaysLeft: finiteNumber(token?.accessDaysLeft),
          refreshExpiresAt: finiteNumber(token?.refreshExpiresAt),
          refreshDaysLeft: finiteNumber(token?.refreshDaysLeft),
          lastRefreshTime: finiteNumber(token?.lastRefreshTime),
        },
        state: {
          credentialReadable: state?.credentialReadable === true,
          credentialEncrypted: state?.credentialEncrypted === true,
          credentialHint: safeHint(state?.credentialHint),
          userAgentFix: state?.userAgentFix === true,
          upstreamHost: shortText(state?.upstreamHost),
        },
        // 多账号：enabled 由 Host 决定；列表逐条白名单化（id/label 三字段/到期/加密/失效），其余丢弃。
        accounts: accounts?.enabled === true
          ? {
              enabled: true,
              activeId: shortText(accounts.activeId),
              sources: (Array.isArray(accounts.sources) ? accounts.sources : []).slice(0, 32).map((source) => ({
                id: shortText(source?.id),
                label: {
                  nickname: shortText(source?.label?.nickname),
                  uidTail: shortText(source?.label?.uidTail),
                  phoneMasked: shortText(source?.label?.phoneMasked),
                },
                accessExpiresAt: finiteNumber(source?.accessExpiresAt),
                encrypted: source?.encrypted === true,
                stale: source?.stale === true,
              })),
            }
          : { enabled: false, activeId: '', sources: [] },
        // 签到：服务缺席时 Host 给的是关闭的零值 DTO，前端归一后形状恒定。
        checkin: normalizeCheckin(checkin),
      }
    }

    function normalizeAction(value) {
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        status: finiteNumber(value?.status),
        sseChunks: value?.sseChunks === true,
        model: shortText(value?.model),
        refreshed: value?.refreshed === true,
        throttled: value?.throttled === true,
        expiresAt: finiteNumber(value?.expiresAt),
      }
    }

    async function readJsonResponse(response, normalize) {
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${finiteNumber(response?.status)}：响应不是有效 JSON`)
      }
      if (response?.ok !== true) {
        // 服务端给了 hint 就用它当正文：`HTTP 500：HTTP 401` 只报事实，
        // 而用户需要的是「下一步做什么」。hint 缺席时回落到既有的状态码文案。
        const hint = safeHint(payload?.hint)
        if (hint !== '') throw new Error(hint)
        const detail = shortText(payload?.error)
        throw new Error(`HTTP ${finiteNumber(response?.status)}${detail === '' ? '' : `：${detail}`}`)
      }
      return normalize(payload)
    }

    async function requestStatus(fetchImpl, signal) {
      const response = await fetchImpl(STATUS_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeStatus)
    }

    /** 多账号：账号列表（GET）。响应经 normalizeAccountSources 白名单化。 */
    function normalizeAccountSources(value) {
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        activeId: shortText(value?.activeId),
        sources: (Array.isArray(value?.sources) ? value.sources : []).slice(0, 32).map((source) => ({
          id: shortText(source?.id),
          label: {
            nickname: shortText(source?.label?.nickname),
            uidTail: shortText(source?.label?.uidTail),
            phoneMasked: shortText(source?.label?.phoneMasked),
          },
          accessExpiresAt: finiteNumber(source?.accessExpiresAt),
          encrypted: source?.encrypted === true,
          stale: source?.stale === true,
        })),
      }
    }

    async function requestCredentialSources(fetchImpl, signal) {
      const response = await fetchImpl(SOURCES_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAccountSources)
    }

    /** 多账号：切换激活账号（POST，body 只带 id）。 */
    async function requestActivateCredentialSource(id, fetchImpl, signal) {
      const response = await fetchImpl(ACTIVE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (value) => ({
        ok: value?.ok === true,
        error: shortText(value?.error),
        activeId: shortText(value?.activeId),
        persisted: value?.persisted === true,
      }))
    }

    // 登录失败的诊断面（与宿主白名单**同源**）：失败时要能说清「哪一步、哪台上游、什么时候」，
    // 而不是只把一个错误码甩给用户。规则本体在 lib/diagnostic-display.mjs；客户端半区由宿主以
    // 经典脚本装载（window.__ModuleLoader__.load 的 factory），不能用 ESM import，这里保留一份
    // 同规则副本，一致性由 test/client-login-hint.test.mjs 的跨层对比（__test.displayRules）锁定。
    //
    // 为什么不是形状正则：`TOKENCANARY.example`、`p13800138000.example`、`{error:'13800138000'}` 与
    // `{code:'13800138000'}` 都能过形状闸门并出现在文案里。只认已知取值，展示面才收敛成有限集合。
    const LOGIN_DIAGNOSTIC_REASONS = ['network', 'http', 'upstream', 'region', 'payload', 'store', 'timeout']
    const LOGIN_DIAGNOSTIC_FIELDS = ['at', 'step', 'reason', 'host', 'domain', 'httpStatus', 'code', 'error']
    const LOGIN_TRACE_LIMIT = 24
    const LOGIN_DISPLAY_STEPS = ['state', 'token', 'credential', 'store']
    const LOGIN_DISPLAY_ERROR_NAMES = ['Error', 'TypeError', 'AbortError', 'SyntaxError']
    const LOGIN_DISPLAY_CODES = [0, 401, 11128, 11217, 12403]
    const LOGIN_DISPLAY_HTTP_MIN = 100
    const LOGIN_DISPLAY_HTTP_MAX = 599
    // 已知域：与宿主 lib/origins.mjs 的 DISPLAY_DOMAINS 同集合（两地区认证域 apex 与主域、
    // CN 生产落款域 www.codebuddy.cn、Intl 后端 host）。
    const LOGIN_DISPLAY_DOMAINS = [
      'copilot.tencent.com',
      'tencent.com',
      'codebuddy.cn',
      'www.codebuddy.cn',
      'workbuddy.ai',
      'codebuddy.ai',
      'www.workbuddy.ai',
      'www.codebuddy.ai',
    ]

    /** 域归一化：能当 URL 解析就走 URL，否则按 host[:port] 处理（小写、去尾点、丢路径与 query）。 */
    function normalizeLoginHost(value) {
      if (typeof value !== 'string') return ''
      const raw = value.trim()
      if (raw === '') return ''
      try {
        const url = new URL(raw.includes('//') ? raw : `https://${raw}`)
        return url.hostname.replace(/\.$/, '').toLowerCase()
      } catch {
        return ''
      }
    }

    /** 阶段名的展示文案；枚举外的值不认识，也不回显原值。 */
    const LOGIN_STAGE_LABELS = {
      state: '获取授权链接',
      token: '轮询授权结果',
      credential: '解析凭据',
      store: '写入账号池',
    }

    /**
     * 单个诊断字段的展示判定（与宿主 `displayField` 同规则）：字符串只认枚举与已知域，
     * 数字只认 `at` / `httpStatus` / `code` 各自的范围，两者互不兜底，其余一律丢字段。
     */
    function loginDisplayField(key, value) {
      if (typeof value === 'string') {
        if (value === '') return undefined
        if (key === 'step') return LOGIN_DISPLAY_STEPS.includes(value) ? value : undefined
        if (key === 'error') return LOGIN_DISPLAY_ERROR_NAMES.includes(value) ? value : undefined
        if (key === 'host' || key === 'domain') {
          const host = normalizeLoginHost(value)
          return LOGIN_DISPLAY_DOMAINS.includes(host) ? host : undefined
        }
        return undefined
      }
      if (!Number.isSafeInteger(value) || value < 0) return undefined
      if (key === 'at') return value
      if (key === 'httpStatus') return value >= LOGIN_DISPLAY_HTTP_MIN && value <= LOGIN_DISPLAY_HTTP_MAX ? value : undefined
      if (key === 'code') return LOGIN_DISPLAY_CODES.includes(value) ? value : undefined
      return undefined
    }

    function normalizeLoginDiagnostic(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const event = {}
      if (LOGIN_DIAGNOSTIC_REASONS.includes(value.reason)) event.reason = value.reason
      for (const key of LOGIN_DIAGNOSTIC_FIELDS) {
        if (key === 'reason') continue
        const item = loginDisplayField(key, value[key])
        if (item !== undefined) event[key] = item
      }
      return Object.keys(event).length === 0 ? null : event
    }

    /** 多账号：浏览器登录（POST 开始 / GET 轮询）。 */
    function normalizeLogin(value) {
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        status: LOGIN_STATUSES.includes(value?.status) ? value.status : 'idle',
        region: value?.region === 'cn' || value?.region === 'intl' ? value.region : '',
        authUrl: typeof value?.authUrl === 'string' && value.authUrl.startsWith('https://') ? value.authUrl : '',
        progress: shortText(value?.progress),
        reason: LOGIN_DIAGNOSTIC_REASONS.includes(value?.reason) ? value.reason : '',
        detail: normalizeLoginDiagnostic(value?.detail),
        trace: Array.isArray(value?.trace)
          ? value.trace.map(normalizeLoginDiagnostic).filter((event) => event !== null).slice(-LOGIN_TRACE_LIMIT)
          : [],
        startedAt: finiteNumber(value?.startedAt),
        completedAt: finiteNumber(value?.completedAt),
        account: {
          id: shortText(value?.account?.id),
          nickname: shortText(value?.account?.nickname),
          phoneMasked: shortText(value?.account?.phoneMasked),
          uidTail: shortText(value?.account?.uidTail),
          sourceId: shortText(value?.account?.sourceId),
        },
      }
    }

    async function requestStartLogin(region, fetchImpl, signal) {
      const response = await fetchImpl(LOGIN_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ region }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeLogin)
    }

    /** 签到：开关（POST checkin/settings）与手动触发（POST checkin/now），两者都返回摘要。 */
    async function requestCheckinSettings(enabled, fetchImpl, signal) {
      const response = await fetchImpl(CHECKIN_SETTINGS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: enabled === true }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (payload) => normalizeCheckin(payload?.checkin))
    }

    async function requestCheckinNow(fetchImpl, signal) {
      const response = await fetchImpl(CHECKIN_NOW_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (payload) => normalizeCheckin(payload?.checkin))
    }

    async function requestLoginStatus(fetchImpl, signal) {
      const response = await fetchImpl(LOGIN_STATUS_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeLogin)
    }

    /**
     * 轮询登录状态直到 complete/error/idle、取消或达到上界。
     * 为什么不在这里 setInterval：SSR 与测试都要能确定性推进，等待函数由调用方注入。
     */
    async function followLoginStatus(fetchImpl, options = {}) {
      const signal = options.signal
      const onUpdate = options.onUpdate
      const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : LOGIN_POLL_INTERVAL_MS
      const maxPolls = Number.isFinite(options.maxPolls) ? options.maxPolls : LOGIN_MAX_POLLS
      let flow = null
      for (let poll = 0; poll < maxPolls; poll += 1) {
        if (signal?.aborted === true) return flow
        try {
          flow = await requestLoginStatus(fetchImpl, signal)
        } catch (error) {
          if (signal?.aborted === true) return flow
          return normalizeLogin({ ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
        if (typeof onUpdate === 'function') onUpdate(flow)
        if (flow.status !== 'pending') return flow
        if (signal?.aborted === true) return flow
        await wait(intervalMs)
      }
      return flow
    }

    /** 只放行 https 授权链接；其余协议（含 javascript:/data:）一律拒绝。 */
    function openAuthUrl(authUrl, open = typeof window === 'undefined' ? undefined : window.open) {
      if (typeof authUrl !== 'string' || !authUrl.startsWith('https://')) return false
      if (typeof open !== 'function') return false
      try {
        open(authUrl, '_blank', 'noopener,noreferrer')
        return true
      } catch {
        return false
      }
    }

    async function requestAction(action, fetchImpl, signal) {
      const route = ACTION_ROUTES[action]
      if (route === undefined) throw new Error('未知的 WorkBuddy 动作')
      const response = await fetchImpl(route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: '{}',
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAction)
    }

    // ── 第二订阅点：智谱清言 Agent ────────────────────────────────────────────
    //
    // 这一段的解析与请求函数是**独立的一套**，不复用 WorkBuddy 的 normalizeStatus /
    // normalizeLogin。理由不是洁癖：两者的身份面与状态机根本不同
    // （WorkBuddy 有 cn/intl 双地区 + OAuth state 轮询；智谱清言只有单一上游 +
    // 「宿主自起浏览器 + cookie 轮询」），把两套字段塞进一个解析器只会让
    // 每处取值都要分支，最后谁都不敢改。

    /** agentmore 登录态：只有状态机与账号显示信息，**没有**授权链接。 */
    function normalizeAgentmoreLogin(value) {
      return {
        ok: value?.ok === true,
        status: AGENTMORE_LOGIN_STATUSES.includes(value?.status) ? value.status : 'idle',
        error: shortText(value?.error),
        // 游客态=「上游已经发了游客令牌，用户还没真正登录」。它是 waiting 的事实，
        // 不是失败：面板据此把提示从「等待登录完成…」换成可执行的下一步。
        guestPending: value?.guestPending === true,
        startedAt: finiteNumber(value?.startedAt),
        completedAt: finiteNumber(value?.completedAt),
        account: {
          id: shortText(value?.account?.id),
          displayName: shortText(value?.account?.displayName),
          userId: shortText(value?.account?.userId),
        },
      }
    }

    /** agentmore 状态摘要：登录与否、当前账号、积分、模型块。 */
    function normalizeAgentmoreStatus(value) {
      const models = value?.models
      return {
        ok: value?.ok === true,
        loggedIn: value?.loggedIn === true,
        error: shortText(value?.error),
        account: {
          id: shortText(value?.account?.id),
          displayName: shortText(value?.account?.displayName),
          userId: shortText(value?.account?.userId),
        },
        credits: {
          remaining: nullableNumber(value?.credits?.remaining),
          display: shortText(value?.credits?.display),
        },
        models: {
          enabled: models?.enabled === true,
          serving: models?.serving === true,
          catalogSource: ['live', 'cache', 'fallback'].includes(models?.catalogSource) ? models.catalogSource : 'none',
          catalogError: safeHint(models?.catalogError) || null,
          conflict: safeHint(models?.conflict) || null,
          enabledModelIds: modelIds(models?.enabledModelIds),
          defaultReasoningEffort: modelEffort(models?.defaultReasoningEffort),
          list: Array.isArray(models?.list) ? models.list : [],
        },
      }
    }

    /** agentmore 账号列表项：只留三个展示字段 + 激活标记。 */
    function normalizeAgentmoreAccounts(value) {
      const list = Array.isArray(value?.accounts) ? value.accounts : []
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        accounts: list.slice(0, 32).map((account) => ({
          id: shortText(account?.id),
          displayName: shortText(account?.displayName),
          userId: shortText(account?.userId),
          active: account?.active === true,
        })),
      }
    }

    async function requestAgentmoreStatus(fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.status, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAgentmoreStatus)
    }

    async function requestAgentmoreStartLogin(fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.login, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: '{}',
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAgentmoreLogin)
    }

    async function requestAgentmoreLoginStatus(fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.loginStatus, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAgentmoreLogin)
    }

    /** 取消登录会顺带关掉宿主起的那只浏览器，因此必须真的发出去。 */
    async function requestAgentmoreCancelLogin(fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.loginCancel, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: '{}',
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAgentmoreLogin)
    }

    async function requestAgentmoreAccounts(fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.accounts, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAgentmoreAccounts)
    }

    async function requestAgentmoreActivate(id, fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.accountActive, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (value) => ({ ok: value?.ok === true, error: shortText(value?.error) }))
    }

    async function requestAgentmoreRemove(id, fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.accountRemove, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (value) => ({ ok: value?.ok === true, error: shortText(value?.error) }))
    }

    /**
     * 真查积分。
     *
     * 未登录时宿主回 `{ok:false, error:'AGENTMORE_NOT_LOGGED_IN'}`（HTTP 200），
     * 因此不能走 `readJsonResponse`（它按 `response.ok` 判成败），要单独处理这一格：
     * 「没登录」不是错误，是列表应有的一个状态。
     */
    async function requestAgentmoreCredits(fetchImpl, signal) {
      const response = await fetchImpl(AGENTMORE_ROUTES.credits, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${finiteNumber(response?.status)}：响应不是有效 JSON`)
      }
      if (response?.ok !== true) {
        throw new Error(safeHint(payload?.hint) || `HTTP ${finiteNumber(response?.status)}：余额请求失败`)
      }
      if (payload?.ok !== true) {
        if (payload?.error === 'AGENTMORE_NOT_LOGGED_IN') return { loggedIn: false, remaining: null, display: '' }
        throw new Error(shortText(payload?.error) || '余额请求失败')
      }
      return {
        loggedIn: true,
        remaining: nullableNumber(payload?.credits?.remaining),
        display: shortText(payload?.credits?.display),
      }
    }

    /**
     * agentmore 的模型请求（读 / 存 / 刷新）。
     *
     * 与 WorkBuddy 的 `requestModelState` 逐字同形（含白名单 body 与错误文案），
     * 只换 URL —— 因为它返回的就是**同形扁平 DTO**，所以 `normalizeModels` 与
     * `ModelsPanel` 可以原样复用。这是刻意对齐的契约，改一边必须同时改另一边。
     */
    async function requestAgentmoreModelState(method, refresh, update, fetchImpl, signal) {
      const response = await fetchImpl(refresh ? AGENTMORE_ROUTES.modelsRefresh : AGENTMORE_ROUTES.models, {
        method, credentials: 'same-origin',
        ...(update === undefined ? {} : {
          headers: JSON_HEADERS,
          body: JSON.stringify(Object.fromEntries(MODEL_PREFERENCE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(update, key)).map((key) => [key, update[key]]))),
        }),
        ...(signal === undefined ? {} : { signal }),
      })
      let payload
      try { payload = await response.json() } catch { throw new Error('模型响应不是有效 JSON，请重试。') }
      if (response.ok !== true) throw new Error(safeHint(payload?.hint) || `HTTP ${finiteNumber(response.status)}：模型请求失败，请重试。`)
      return normalizeModels(payload)
    }
    const requestAgentmoreModels = (fetchImpl, signal) => requestAgentmoreModelState('GET', false, undefined, fetchImpl, signal)
    const requestAgentmoreSaveModels = (update, fetchImpl, signal) => requestAgentmoreModelState('POST', false, update, fetchImpl, signal)
    const requestAgentmoreRefreshModels = (fetchImpl, signal) => requestAgentmoreModelState('POST', true, undefined, fetchImpl, signal)

    async function runActionAndReload(action, fetchImpl, signal) {
      let actionResult
      let actionError = ''
      try {
        actionResult = await requestAction(action, fetchImpl, signal)
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error)
      }

      let status
      let statusError = ''
      try {
        status = await requestStatus(fetchImpl, signal)
      } catch (error) {
        statusError = error instanceof Error ? error.message : String(error)
      }
      return { actionResult, actionError, status, statusError }
    }

    function formatNumber(value) {
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
    }

    function formatTime(value) {
      if (!Number.isFinite(value) || value <= 0) return '未提供'
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(value))
      } catch {
        return '未提供'
      }
    }

    function formatExpiry(expiresAt, daysLeft) {
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) return '未提供'
      return `${formatTime(expiresAt)} · ${daysLeft} 天`
    }

    function displayText(value) {
      return value === '' ? '未提供' : value
    }

    function DataRows({ rows }) {
      return h(
        'dl',
        { className: 'wb-settings__rows' },
        rows.flatMap(([label, value], index) => [
          h('dt', { key: `label-${index}` }, label),
          h('dd', { key: `value-${index}` }, value),
        ]),
      )
    }

    // 余额失败文案：按宿主下发的稳定枚举给出可行动提示；未知/缺省退化为旧文案。
    function creditsErrorText(error) {
      if (error === 'auth-rejected') return '凭据已被上游拒绝（HTTP 401）。请重新登录该账号后查看余额'
      if (error === 'request-failed') return '余额请求失败（网络或上游暂时不可用），请稍后重试或重新打开设置'
      if (error === 'upstream-invalid') return '上游响应无法解析为余额，请稍后重试；若持续出现请反馈'
      return '上游未提供余额'
    }

    function Credits({ credits }) {
      if (credits?.ok !== true) {
        return h('p', { className: 'wb-settings__muted' }, creditsErrorText(credits?.error))
      }
      return h(
        'div',
        { className: 'wb-settings__credits' },
        h(
          'div',
          { className: 'wb-settings__balance', 'aria-label': `剩余 ${formatNumber(credits.remaining)}` },
          h('span', { className: 'wb-settings__diamond', 'aria-hidden': 'true' }, '♦'),
          h('strong', { className: 'wb-settings__remaining' }, formatNumber(credits.remaining)),
          h('span', { className: 'wb-settings__remaining-label' }, '剩余'),
        ),
        h(
          'div',
          { className: 'wb-settings__credit-meta' },
          h('span', { className: 'wb-settings__metric' },
            h('span', { className: 'wb-settings__metric-label' }, '总额'),
            h('span', { className: 'wb-settings__metric-value' }, formatNumber(credits.total)),
          ),
          h('span', { className: 'wb-settings__metric' },
            h('span', { className: 'wb-settings__metric-label' }, '已用'),
            h('span', { className: 'wb-settings__metric-value' }, formatNumber(credits.used)),
          ),
        ),
        h(
          'p',
          { className: 'wb-settings__muted wb-settings__credit-note' },
          credits.stale === true ? '上次成功值 · 按 WorkBuddy 服务端余额口径' : '按 WorkBuddy 服务端余额口径',
        ),
      )
    }

    function actionMessage(action, result) {
      if (action === 'test') {
        if (result?.ok === true) return `连接测试通过${result.model === '' ? '' : ` · ${result.model}`}`
        const status = result?.status > 0 ? `（HTTP ${result.status}）` : ''
        return `连接测试未通过${status}`
      }
      if (action === 'refresh') {
        return result?.throttled === true ? '刷新受安全间隔限制；状态已重新读取。' : '刷新凭证已完成；状态已重新读取。'
      }
      return 'CodeBuddy 登录态已重新读取。'
    }

    /** 多账号切换区：只在 Host 启用（accounts.enabled）时由 Section 渲染。 */
    function AccountSwitcher({ accounts, onSwitch, switchingId }) {
      if (accounts?.enabled !== true || accounts.sources.length === 0) return null
      return h(
        'div',
        { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '切换账号'),
        h(
          'div',
          { className: 'wb-settings__actions', role: 'group', 'aria-label': '切换 WorkBuddy 账号' },
          accounts.sources.map((source) =>
            h(
              'button',
              {
                key: source.id,
                type: 'button',
                className: 'wb-settings__button',
                'data-wb-active': source.id === accounts.activeId ? 'true' : undefined,
                disabled: source.id === accounts.activeId || switchingId !== '',
                onClick: () => onSwitch(source.id),
              },
              `${source.label.nickname === '' ? '未命名账号' : source.label.nickname}${source.label.phoneMasked === '' ? '' : ` · ${source.label.phoneMasked}`}${source.id === accounts.activeId ? '（当前）' : ''}${source.encrypted ? '（已加密）' : ''}${source.stale ? '（已失效）' : ''}`,
            ),
          ),
        ),
        accounts.sources.some((source) => source.stale)
          ? h('p', { className: 'wb-settings__muted wb-settings__risk' }, '标「已失效」的账号被上游拒绝过（401/403）；切过去前建议先在 CodeBuddy 里重新登录。')
          : null,
        accounts.sources.some((source) => source.encrypted)
          ? h('p', { className: 'wb-settings__muted' }, '标「已加密」的账号由 WorkBuddy 桌面端加密保存，本插件读不到令牌，因此无法刷新或切换；用下方浏览器登录添加一份自己的凭据即可。')
          : null,
        switchingId !== '' ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在切换账号…') : null,
      )
    }

    /** 登录区：只在 Host 启用多账号时渲染；成功只添加账号，不切换激活账号。 */
    function LoginPanel({ login, region, onRegion, onStart, busy, enabled }) {
      if (enabled !== true) return null
      const status = login?.status ?? 'idle'
      const regionButton = (value, label) => h(
        'button',
        {
          type: 'button',
          className: 'wb-settings__button',
          'data-wb-region': value,
          'data-wb-selected': region === value ? 'true' : undefined,
          disabled: busy,
          onClick: () => onRegion(value),
        },
        label,
      )
      return h(
        'div',
        { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '添加账号'),
        h(
          'div',
          { className: 'wb-settings__actions', role: 'group', 'aria-label': '登录地区' },
          regionButton('cn', '国内版'),
          regionButton('intl', '国际版'),
        ),
        h(
          'div',
          { className: 'wb-settings__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-settings__button',
              disabled: busy,
              onClick: () => onStart(region),
            },
            status === 'pending' ? '等待授权…' : '开始登录',
          ),
        ),
        status === 'pending' ? h('p', { className: 'wb-settings__muted', role: 'status' }, login.progress === '' ? '等待浏览器授权…' : login.progress) : null,
        status === 'pending' && login.authUrl !== ''
          ? h('p', { className: 'wb-settings__guide' },
            h('a', { className: 'wb-settings__link', href: login.authUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开授权页面'))
          : null,
        status === 'complete'
          ? h('p', { className: 'wb-settings__alert wb-settings__risk', role: 'status' },
            `已添加：${displayText(login.account.nickname)}${login.account.phoneMasked === '' ? '' : ` · ${login.account.phoneMasked}`}（推理仍使用当前激活账号）`)
          : null,
        status === 'error'
          ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `登录失败：${displayText(login.error)}`)
          : null,
        status === 'error' ? h('p', { className: 'wb-settings__muted' }, loginFailureHint(login)) : null,
        h('p', { className: 'wb-settings__muted wb-settings__risk' }, '浏览器登录会打开上游授权页面；完成后账号进入本机加密账号池，不会自动切换当前账号。'),
      )
    }

    /** 失败反馈：先给「下一步该做什么」（宿主 progress 里的可行动文案），再补一格脱敏定位。 */
    function loginFailureHint(login) {
      const action = login.progress === '' ? '请重新登录；若反复失败，请检查网络或代理后重试' : login.progress
      const where = loginFailureWhere(login)
      return where === '' ? action : `${action}（${where}）`
    }

    /** 取最后一条轨迹（退化为 detail）：阶段 · 上游 · HTTP · 业务码 · 时间，全是脱敏短标量。 */
    function loginFailureWhere(login) {
      const last = login.trace.length > 0 ? login.trace[login.trace.length - 1] : login.detail
      if (last === null || typeof last !== 'object') return ''
      const parts = []
      if (typeof last.step === 'string') parts.push(LOGIN_STAGE_LABELS[last.step] ?? '未知阶段')
      const host = last.host ?? last.domain
      if (typeof host === 'string') parts.push(host)
      if (Number.isSafeInteger(last.httpStatus)) parts.push(`HTTP ${last.httpStatus}`)
      if (Number.isSafeInteger(last.code)) parts.push(`业务码 ${last.code}`)
      if (Number.isSafeInteger(last.at)) parts.push(formatTime(last.at))
      return parts.join(' · ')
    }

    /**
     * 自动签到区：只读展示当日计数，写操作走两条 POST 路由。
     * busy 期间两个控件都禁用；失败只显示路由给的固定错误码，绝不回显原始错误对象。
     */
    function CheckinPanel({ checkin, busy, onToggle, onRun }) {
      const disabled = busy !== ''
      return h(
        'div',
        { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '自动签到'),
        h(
          'div',
          { className: 'wb-settings__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-settings__button',
              disabled,
              'data-wb-checkin-toggle': checkin.enabled ? 'on' : 'off',
              'aria-pressed': checkin.enabled,
              onClick: () => onToggle(!checkin.enabled),
            },
            busy === 'toggle' ? '保存中…' : checkin.enabled ? '关闭自动签到' : '开启自动签到',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wb-settings__button',
              disabled,
              'data-wb-checkin-run': 'true',
              onClick: () => onRun(),
            },
            busy === 'manual' ? '签到进行中…' : '立即签到',
          ),
        ),
        h(
          'p',
          { className: 'wb-settings__hint', role: 'status' },
          `今日成功 ${checkin.doneToday} · 跳过 ${checkin.skippedToday} · 失败 ${checkin.failedToday} · 可用账号 ${checkin.totalAccounts}`,
        ),
        h('p', { className: 'wb-settings__muted' }, `最近一次：${checkin.lastRunAt > 0 ? formatTime(checkin.lastRunAt) : '—'}`),
        h('p', { className: 'wb-settings__muted wb-settings__risk' }, '自动签到每天一次，只为国内版账号执行；国际版与加密信封账号跳过。手动签到会立即排队执行。'),
      )
    }

    const MODELS_ROUTE = `${ROUTE_PREFIX}/models`
    const MODEL_PREFERENCE_KEYS = ['enabled', 'enabledModelIds', 'defaultReasoningEffort', 'contextWindowOverrides']
    const modelNumber = (value) => Number.isSafeInteger(value) && value > 0 ? value : null
    const modelEffort = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,15}$/.test(value) && value !== 'off' ? value : null
    const modelIds = (value) => [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(id)))]

    function normalizeModels(value) {
      const seen = new Set()
      const models = (Array.isArray(value?.models) ? value.models : []).filter((item) => {
        const id = modelIds([item?.id])[0]
        if (!id || seen.has(id)) return false
        seen.add(id)
        return true
      }).map((item) => {
        const id = item.id
        const efforts = [...new Set((Array.isArray(item.reasoningEfforts) ? item.reasoningEfforts : []).map(modelEffort).filter(Boolean))]
        return {
          id, name: safeHint(item.name) || id,
          contextWindow: modelNumber(item.contextWindow), maxContextWindow: modelNumber(item.maxContextWindow),
          maxTokens: modelNumber(item.maxTokens),
          inputModalities: [...new Set((Array.isArray(item.inputModalities) ? item.inputModalities : []).filter((input) => input === 'text' || input === 'image'))],
          reasoningEfforts: efforts,
          defaultReasoningEffort: efforts.includes(item.defaultReasoningEffort) ? item.defaultReasoningEffort : null,
          enabled: item.enabled === true, contextWindowOverride: modelNumber(item.contextWindowOverride),
          effectiveContextWindow: modelNumber(item.effectiveContextWindow),
          effectiveReasoningEffort: efforts.includes(item.effectiveReasoningEffort) ? item.effectiveReasoningEffort : null,
        }
      })
      return {
        ok: value?.ok === true, enabled: value?.enabled !== false,
        enabledModelIds: modelIds(value?.enabledModelIds), defaultReasoningEffort: modelEffort(value?.defaultReasoningEffort),
        contextWindowOverrides: Object.fromEntries(Object.entries(value?.contextWindowOverrides ?? {})
          .filter(([id, size]) => modelIds([id]).length > 0 && modelNumber(size) !== null)),
        region: value?.region === 'cn' || value?.region === 'intl' ? value.region : null,
        catalogSource: ['live', 'cache', 'fallback'].includes(value?.catalogSource) ? value.catalogSource : 'none',
        catalogError: safeHint(value?.catalogError) || null, serving: value?.serving === true,
        conflict: safeHint(value?.conflict) || null, models,
      }
    }

    async function requestModelState(method, refresh, update, fetchImpl, signal) {
      const response = await fetchImpl(refresh ? `${MODELS_ROUTE}/refresh` : MODELS_ROUTE, {
        method, credentials: 'same-origin',
        ...(update === undefined ? {} : {
          headers: JSON_HEADERS,
          body: JSON.stringify(Object.fromEntries(MODEL_PREFERENCE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(update, key)).map((key) => [key, update[key]]))),
        }),
        ...(signal === undefined ? {} : { signal }),
      })
      let payload
      try { payload = await response.json() } catch { throw new Error('模型响应不是有效 JSON，请重试。') }
      if (response.ok !== true) throw new Error(safeHint(payload?.hint) || `HTTP ${finiteNumber(response.status)}：模型请求失败，请重试。`)
      return normalizeModels(payload)
    }
    const requestModels = (fetchImpl, signal) => requestModelState('GET', false, undefined, fetchImpl, signal)
    const requestSaveModels = (update, fetchImpl, signal) => requestModelState('POST', false, update, fetchImpl, signal)
    const requestRefreshModels = (fetchImpl, signal) => requestModelState('POST', true, undefined, fetchImpl, signal)

    function modelDraft(state) {
      return {
        enabled: state.enabled, enabledModelIds: [...state.enabledModelIds], defaultReasoningEffort: state.defaultReasoningEffort,
        contextWindowOverrides: Object.fromEntries(Object.entries(state.contextWindowOverrides).map(([id, size]) => [id, String(size)])),
      }
    }

    function modelUpdate(draft, models) {
      const overrides = {}
      for (const [id, input] of Object.entries(draft.contextWindowOverrides)) {
        const value = String(input).trim()
        const size = Number(value)
        const model = models.find((item) => item.id === id)
        if (value !== '' && (!/^\d+$/.test(value) || modelNumber(size) === null || (model?.maxContextWindow !== null && model?.maxContextWindow !== undefined && size > model.maxContextWindow))) {
          throw new Error(`${model?.name || id}：上下文覆盖须为正整数${model?.maxContextWindow ? `，且不超过 ${model.maxContextWindow.toLocaleString('en-US')}` : ''}；留空可清除覆盖。`)
        }
        Object.defineProperty(overrides, id, { value: value === '' ? null : size, enumerable: true })
      }
      return { ...draft, contextWindowOverrides: overrides }
    }

    /**
     * 模型管理面板。
     *
     * 两个订阅点**共用这一个组件**：它们的 `/models` 路由返回的是同形扁平 DTO，
     * 差别只有 URL 与供应商显示名，因此用 props 注入请求函数即可。
     *
     * 默认值绑定的仍是模块级的 WorkBuddy 请求函数 —— 这样既有调用点（含测试）
     * 一字不改，行为与文案逐字保持原样。
     */
    function ModelsPanel({
      initialModels = undefined,
      accountRevision = 0,
      externalBusy = false,
      requestModels: loadModels = requestModels,
      requestSaveModels: saveModels = requestSaveModels,
      requestRefreshModels: refreshModels = requestRefreshModels,
      providerLabel = 'WorkBuddy',
      titleId = 'workbuddy-models-title',
    } = {}) {
      const [modelState, setModelState] = useState(() => initialModels === undefined ? null : normalizeModels(initialModels))
      const [draft, setDraft] = useState(() => initialModels === undefined ? null : modelDraft(normalizeModels(initialModels)))
      const [loading, setLoading] = useState(initialModels === undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const controllerRef = useRef(null)
      const operationRef = useRef(false)
      const dirtyRef = useRef(false)

      useEffect(() => {
        const controller = new AbortController()
        controllerRef.current = controller
        operationRef.current = false
        setBusy('')
        setLoading(true)
        setNotice(null)
        setModelState(null)
        loadModels(fetch, controller.signal).then((next) => {
          if (controller.signal.aborted) return
          setModelState(next)
          if (!dirtyRef.current) setDraft(modelDraft(next))
          setLoading(false)
        }, () => {
          if (controller.signal.aborted) return
          setNotice({ error: true, text: '模型状态读取失败，请点击“刷新模型目录”重试。' })
          setLoading(false)
        })
        return () => controller.abort()
      }, [accountRevision])

      const edit = (update) => {
        dirtyRef.current = true
        setNotice(null)
        setDraft((current) => ({ ...current, ...update(current) }))
      }
      const run = async (mode) => {
        if (operationRef.current || loading || externalBusy) return
        let update
        if (mode === 'save') {
          if (!draft || modelState?.ok !== true) return
          try { update = modelUpdate(draft, modelState.models) } catch (error) {
            setNotice({ error: true, text: error.message })
            return
          }
        }
        operationRef.current = true
        setBusy(mode)
        setNotice(null)
        const signal = controllerRef.current?.signal
        try {
          const next = mode === 'save' ? await saveModels(update, fetch, signal) : await refreshModels(fetch, signal)
          if (signal?.aborted) return
          if (!next.ok) throw new Error(next.catalogError || '模型配置不可用，请检查后重试。')
          setModelState(next)
          if (mode === 'save' || !draft) {
            setDraft(modelDraft(next))
            dirtyRef.current = false
          }
          setNotice({ error: false, text: mode === 'save' ? '模型设置已保存；当前聊天模型保持不变。' : '模型目录已刷新；待保存选择保持不变。' })
        } catch (error) {
          if (signal?.aborted) return
          setNotice({ error: true, text: safeHint(error?.message) || '模型请求失败，请重试；待编辑设置已保留。' })
        } finally {
          if (!signal?.aborted) {
            operationRef.current = false
            setBusy('')
          }
        }
      }

      const disabled = loading || busy !== '' || externalBusy
      const editable = disabled || !draft || modelState?.ok !== true
      const models = modelState?.models || []
      const efforts = [...new Set(models.flatMap((model) => model.reasoningEfforts))]
      const selected = draft?.enabledModelIds || []
      const unavailable = selected.filter((id) => !models.some((model) => model.id === id)).length
      const amount = (size) => size === null ? '未提供' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(size)
      const selectedModels = models.filter((model) => selected.includes(model.id))
      const sources = { live: '官方实时目录', cache: '同账号缓存', fallback: '本地候选目录', none: '暂无目录' }
      const action = (label, onClick, extraDisabled = false) => h('button', {
        className: 'wb-settings__button', type: 'button', disabled: disabled || extraDisabled, onClick,
      }, label)

      return h('div', { className: 'wb-settings__section', 'aria-labelledby': titleId, 'aria-busy': disabled },
        h('h4', { className: 'wb-settings__section-title', id: titleId }, '模型管理'),
        h('p', { className: 'wb-settings__muted' }, `已选 ${selected.length}；${modelState?.region === 'cn' ? '中国大陆' : modelState?.region === 'intl' ? '国际地区' : '未登录账号'}；${sources[modelState?.catalogSource || 'none']}`),
        h('p', { className: 'wb-settings__muted' }, modelState?.serving ? '供应商正在提供原生模型。' : modelState?.enabled === false ? `供应商已关闭；所有 ${providerLabel} 模型已隐藏。` : '供应商未提供原生模型；保存已选模型后生效。'),
        loading ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在读取模型状态…') : null,
        !loading && modelState?.region === null ? h('p', { className: 'wb-settings__muted' }, '请先完成账号登录，再刷新模型目录。') : null,
        modelState?.catalogError ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `目录读取提示：${modelState.catalogError}`) : null,
        modelState?.conflict ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `供应商冲突：${modelState.conflict}；现有供应商配置保持不变。`) : null,
        modelState?.ok === false ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, '模型配置不可用，请检查后刷新；现有配置保持不变。') : null,
        h('label', { className: 'wb-settings__model-choice' },
          h('input', { type: 'checkbox', checked: draft?.enabled === true, disabled: editable, 'aria-label': `启用 ${providerLabel} 模型供应商`,
            onChange: (event) => edit(() => ({ enabled: event.target.checked })) }), `启用 ${providerLabel} 模型供应商`),
        h('p', { className: 'wb-settings__muted' }, '勾选并保存后加入原生选择器；默认不勾选任何模型。'),
        h('div', { className: 'wb-settings__model-toolbar' },
          h('span', { className: 'wb-settings__model-count' }, `${selectedModels.length}/${models.length}`),
          h('div', { className: 'wb-settings__actions' },
            action('全选', () => edit((current) => ({ enabledModelIds: [...new Set([...current.enabledModelIds, ...models.map((model) => model.id)])] })), editable || models.length === 0),
            action('全不选', () => edit(() => ({ enabledModelIds: [] })), editable || selected.length === 0))),
        unavailable ? h('p', { className: 'wb-settings__muted' }, `${unavailable} 个已选模型在当前目录外；保留偏好，但不加入原生列表。`) : null,
        !loading && models.length === 0 ? h('p', { className: 'wb-settings__muted' }, '暂无可用模型；可刷新目录，现有选择保持不变。') : null,
        h('div', { className: 'wb-settings__model-list', role: 'group', 'aria-label': '可用模型' },
          ...models.map((model) => h('label', { className: 'wb-settings__model-row', key: model.id, title: model.id },
            h('span', { className: 'wb-settings__model-copy' },
              h('span', { className: 'wb-settings__model-name' }, model.name),
              h('span', { className: 'wb-settings__model-meta' }, [amount(model.contextWindow), model.inputModalities.includes('image') ? '图片' : '纯文本', model.reasoningEfforts.join('/')].filter(Boolean).join(' · '))),
            h('input', { type: 'checkbox', checked: selected.includes(model.id), disabled: editable, 'data-wb-model-id': model.id,
              'aria-label': `选择 ${model.name}`, onChange: (event) => edit((current) => ({ enabledModelIds: event.target.checked
                ? [...new Set([...current.enabledModelIds, model.id])] : current.enabledModelIds.filter((id) => id !== model.id) })) })))),
        h('div', { className: 'wb-settings__enhancements', role: 'group', 'aria-label': '增强功能' },
          h('h4', { className: 'wb-settings__section-title' }, '增强功能'),
          h('label', { className: 'wb-settings__model-field' },
            h('span', null, '默认思考深度', h('small', null, '控制支持推理的模型在未单独指定时的思考强度。')),
            h('select', { className: 'wb-settings__model-input', 'aria-label': '默认思考深度',
              value: efforts.includes(draft?.defaultReasoningEffort) ? draft.defaultReasoningEffort : '', disabled: editable,
              onChange: (event) => edit(() => ({ defaultReasoningEffort: event.target.value || null })) },
              h('option', { value: '' }, '使用模型默认值'),
              ...efforts.map((effort) => h('option', { key: effort, value: effort }, effort)))),
          draft?.defaultReasoningEffort && !efforts.includes(draft.defaultReasoningEffort)
            ? h('p', { className: 'wb-settings__muted' }, '已保存档位不受当前目录支持；各模型采用官方默认，原偏好保持不变。') : null,
          h('h5', null, '模型上下文窗口'),
          h('p', { className: 'wb-settings__muted' }, '默认值来自官方模型目录，可覆盖自定义容量，用于 DSH 的压缩与溢出判断。以 token 数填写，留空使用官方默认。'),
          selectedModels.length === 0 ? h('p', { className: 'wb-settings__muted' }, '还没有勾选任何模型。在上方勾选后，这里会出现该模型的上下文窗口设置。') : null,
          ...selectedModels.map((model) => h('label', { className: 'wb-settings__model-field', key: model.id },
            h('span', null, model.name, h('small', null, `默认 ${amount(model.contextWindow)}${model.maxContextWindow ? ` · 上限 ${amount(model.maxContextWindow)}` : ''}`)),
            h('input', { className: 'wb-settings__model-input', type: 'text', inputMode: 'numeric', pattern: '[0-9]*',
              'aria-label': `${model.name} 上下文覆盖`, value: draft?.contextWindowOverrides[model.id] ?? '', disabled: editable, placeholder: '使用官方默认',
              onChange: (event) => edit((current) => ({ contextWindowOverrides: { ...current.contextWindowOverrides, [model.id]: event.target.value } })) }))),
          h('div', { className: 'wb-settings__model-reset' },
            action('全部恢复默认', () => edit((current) => ({ contextWindowOverrides: Object.fromEntries(Object.keys(current.contextWindowOverrides).map((id) => [id, ''])) })),
              editable || !Object.values(draft?.contextWindowOverrides || {}).some((value) => String(value).trim() !== '')))),
        h('div', { className: 'wb-settings__actions wb-settings__risk' },
          action(busy === 'save' ? '正在保存…' : '保存模型设置', () => run('save'), editable),
          action(busy === 'refresh' ? '正在刷新目录…' : '刷新模型目录', () => run('refresh'))),
        notice ? h('p', { className: `wb-settings__alert wb-settings__risk${notice.error ? ' wb-settings__alert--error' : ''}`,
          role: notice.error ? 'alert' : 'status', 'aria-live': 'polite' }, notice.text) : null)
    }

    /**
     * 订阅点总览：本插件只占设置页里**一张**座位。
     *
     * 为什么不注册两张：`settings.section` 的每一张座位都是设置页导航里的一个独立条目，
     * 两个订阅点各占一行会让人以为这是两个插件；而且 order 是全局排序键，多占一个槽位
     * 就会把别家插件往后挤一格。参考 `dsh-chatgpt-subscription` 的做法：一张座位 + 总览卡。
     *
     * 视图状态存 sessionStorage 而不是宿主状态：这是纯导航记忆，刷新设置页后回到总览
     * 比停在某个详情页更符合预期，也不值得为它加一条宿主路由。
     *
     * `initialView` / `initialStatus` 是给离线测试用的塞子：不传 `initialView` 时读
     * sessionStorage（真实行为）；传了就固定在该视图，SSR 断言由此可以直达详情页。
     */
    function SubscriptionHub({ initialView = undefined, initialStatus = undefined, initialLogin = undefined, initialCheckinBusy = undefined, initialModels = undefined } = {}) {
      const [view, setView] = useState(() => initialView === undefined ? readHubView() : normalizeHubView(initialView))

      const open = (id) => {
        const next = normalizeHubView({ view: 'detail', id })
        storeHubView(next)
        setView(next)
      }
      const back = () => {
        const next = { view: 'overview' }
        storeHubView(next)
        setView(next)
      }

      if (view.view === 'overview') {
        return h('section', { className: 'wb-settings', 'aria-labelledby': 'wb-hub-title' },
          h('style', null, styles),
          h('header', { className: 'wb-settings__head' },
            h('h3', { className: 'wb-settings__title', id: 'wb-hub-title' }, '订阅服务'),
            h('p', { className: 'wb-settings__lede' }, '本插件提供两个独立的订阅点，点进去分别登录与查看额度。')),
          h('div', { className: 'wb-settings__hub-list' }, HUB_PROVIDERS.map((provider) => h('button', {
            key: provider.id,
            type: 'button',
            className: 'wb-settings__hub-card',
            'data-hub-provider': provider.id,
            onClick: () => open(provider.id),
          },
          h('span', { className: 'wb-settings__hub-tile' },
            h('img', { src: provider.icon, alt: '', 'aria-hidden': 'true', draggable: 'false' })),
          h('span', { className: 'wb-settings__hub-copy' },
            h('span', { className: 'wb-settings__hub-name' }, provider.name),
            h('span', { className: 'wb-settings__hub-line' }, provider.line)),
          h('span', { className: 'wb-settings__hub-chevron', 'aria-hidden': 'true' }, '›')))))
      }

      const provider = hubProvider(view.id)
      // 详情页页眉只留图标、名称与一行说明。**不**再放第二个订阅点名做 <h4>：
      // 详情卡自己的 <h3> 已经是同一个名字，两行同名是用户实测反馈的缺陷。
      return h('section', { className: 'wb-settings', 'aria-labelledby': 'wb-hub-detail-title' },
        h('style', null, styles),
        h('button', { type: 'button', className: 'wb-settings__hub-back', onClick: back }, '‹ 返回订阅总览'),
        h('div', { className: 'wb-settings__detail-head' },
          h('span', { className: 'wb-settings__detail-mark' },
            h('img', { src: provider.icon, alt: '', 'aria-hidden': 'true', draggable: 'false' })),
          h('span', null,
            h('h4', { className: 'wb-settings__detail-title', id: 'wb-hub-detail-title' }, provider.name),
            h('p', { className: 'wb-settings__detail-line' }, provider.line))),
        provider.render({ initialStatus, initialLogin, initialCheckinBusy, initialModels, inHub: true }))
    }

    /**
     * 两个订阅点的静态描述。渲染函数放在这里，详情页就不必再写一遍 if/else。
     *
     * `icon` 是各家**官方**标识，内联成 data URI 而非外链：
     *   * `dsh-workbuddy-auth` 的 Web 端跑在 `dsh-app://` 下，外链图标要额外的网络与
     *     域名许可；内联则零请求、离线可用，也不会在 CSP 收紧时变成破图。
     *   * 图形逐字节取自官方站点（WorkBuddy: workbuddy.ai 的 `assets/logo.svg`；
     *     智谱清言: chatglm.cn 的 `favicon.ico`，即 64×64 PNG）。
     *   * alt 留空 + aria-hidden：图标不携带语义，名称就在同一行的文本里。
     */
    const HUB_PROVIDERS = [
      {
        id: 'workbuddy',
        name: 'WorkBuddy',
        icon: WORKBUDDY_ICON,
        line: '腾讯 Copilot 订阅 · 使用本机 CodeBuddy 登录态',
        render: (props) => h(Section, props),
      },
      {
        id: 'agentmore',
        name: '智谱清言 Agent',
        icon: AGENTMORE_ICON,
        line: 'chatglm.cn 账号 · 独立额度与模型勾选',
        render: (props) => h(AgentmoreSection, props),
      },
    ]

    function hubProvider(id) {
      return HUB_PROVIDERS.find((provider) => provider.id === id) ?? HUB_PROVIDERS[0]
    }

    /**
     * 视图归一。只认两种形态：总览，或指向一个**已知**订阅点的详情。
     * 未知 id 一律退回总览 —— 否则删掉一个订阅点后，用户会被永久卡在
     * 指向已消失条目的详情页上（storage 里残留旧 id 是完全可能的）。
     */
    function normalizeHubView(value) {
      if (value !== null && typeof value === 'object' && value.view === 'detail') {
        const id = typeof value.id === 'string' ? value.id : ''
        if (HUB_PROVIDERS.some((provider) => provider.id === id)) return { view: 'detail', id }
      }
      return { view: 'overview' }
    }

    const HUB_VIEW_KEY = 'dsh-workbuddy-auth:hub-view'

    function readHubView() {
      try {
        return normalizeHubView(JSON.parse(sessionStorage.getItem(HUB_VIEW_KEY) ?? 'null'))
      } catch {
        return { view: 'overview' }
      }
    }

    function storeHubView(view) {
      try {
        sessionStorage.setItem(HUB_VIEW_KEY, JSON.stringify(view))
      } catch {
        // 隐私模式下 sessionStorage 可能抛错：视图记忆失败不影响功能。
      }
    }

    /**
     * @param {object} [props]
     * @param {boolean} [props.inHub] 在订阅总览的详情页里渲染。
     *
     * `inHub` 时**不**渲染自己的 `<header>`：详情页页眉已经有图标、名称与一行说明，
     * 卡片再画一遍就是同名两行（用户实测反馈的重复标题）。独立成节时仍保留页眉，
     * 这样组件既能进 hub，也能被别处单独挂载。
     */
    function Section({ initialStatus, initialLogin, initialCheckinBusy, initialModels = undefined, inHub = false } = {}) {
      const [status, setStatus] = useState(() => initialStatus === undefined ? null : normalizeStatus(initialStatus))
      const [modelRevision, setModelRevision] = useState(0)
      const [loading, setLoading] = useState(initialStatus === undefined)
      const [loadError, setLoadError] = useState('')
      const [busyAction, setBusyAction] = useState('')
      const [switchingId, setSwitchingId] = useState('')
      const [login, setLogin] = useState(() => initialLogin === undefined ? null : normalizeLogin(initialLogin))
      const [loginRegion, setLoginRegion] = useState(() => (initialLogin?.region === 'intl' ? 'intl' : 'cn'))
      const [loginBusy, setLoginBusy] = useState(false)
      const [checkinBusy, setCheckinBusy] = useState(() => (initialCheckinBusy === 'toggle' || initialCheckinBusy === 'manual' ? initialCheckinBusy : ''))
      const [notice, setNotice] = useState(null)
      const mountedRef = useRef(false)
      const controllerRef = useRef(null)
      const actionInFlightRef = useRef(false)

      useEffect(() => {
        mountedRef.current = true
        const controller = new AbortController()
        controllerRef.current = controller
        setLoading(true)
        requestStatus(fetch, controller.signal).then(
          (nextStatus) => {
            if (!mountedRef.current || controller.signal.aborted) return
            setStatus(nextStatus)
            setModelRevision((current) => current + 1)
            setLoadError('')
            setLoading(false)
          },
          (error) => {
            if (!mountedRef.current || controller.signal.aborted) return
            setLoadError(error instanceof Error ? error.message : String(error))
            setLoading(false)
          },
        )
        return () => {
          mountedRef.current = false
          actionInFlightRef.current = false
          controller.abort()
          if (controllerRef.current === controller) controllerRef.current = null
        }
      }, [])

      const runAction = async (action) => {
        if (actionInFlightRef.current) return
        actionInFlightRef.current = true
        setBusyAction(action)
        setNotice(null)
        const signal = controllerRef.current?.signal
        const result = await runActionAndReload(action, fetch, signal)
        if (signal?.aborted === true) return

        setModelRevision((current) => current + 1)
        if (result.status !== undefined) {
          setStatus(result.status)
          setLoadError('')
        } else if (result.statusError !== '') {
          setLoadError(result.statusError)
        }

        if (result.actionError !== '') {
          setNotice({ kind: 'error', text: `${result.actionError}；已尝试重新读取状态。` })
        } else if (result.statusError !== '') {
          setNotice({ kind: 'error', text: `动作已完成，但重新读取状态失败：${result.statusError}` })
        } else {
          const ok = result.actionResult?.ok === true
          setNotice({ kind: ok ? 'success' : 'error', text: actionMessage(action, result.actionResult) })
        }
        actionInFlightRef.current = false
        setBusyAction('')
      }

      const runSwitch = async (id) => {
        if (actionInFlightRef.current || switchingId !== '') return
        actionInFlightRef.current = true
        setSwitchingId(id)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let switchError = ''
        try {
          await requestActivateCredentialSource(id, fetch, signal)
          if (signal?.aborted === true) return
          setModelRevision((current) => current + 1)
        } catch (error) {
          switchError = error instanceof Error ? error.message : String(error)
        }
        let nextStatus
        let statusError = ''
        try {
          nextStatus = await requestStatus(fetch, signal)
        } catch (error) {
          statusError = error instanceof Error ? error.message : String(error)
        }
        if (signal?.aborted === true) return
        if (nextStatus !== undefined) {
          setStatus(nextStatus)
          setLoadError('')
        } else if (statusError !== '') {
          setLoadError(statusError)
        }
        setNotice(switchError === ''
          ? { kind: 'success', text: '账号已切换；推理与积分将使用新账号。' }
          : { kind: 'error', text: `切换失败：${switchError}` })
        actionInFlightRef.current = false
        setSwitchingId('')
      }

      const isBusy = busyAction !== '' || switchingId !== '' || loginBusy || checkinBusy !== ''
      const controlsDisabled = isBusy || loading

      /**
       * 开始浏览器登录：Host 返回授权 URL → 打开新标签 → 轮询本机状态。
       * 成功只刷新账号列表，绝不切换激活账号（登录=添加）。
       */
      const runLogin = async (region) => {
        if (actionInFlightRef.current) return
        actionInFlightRef.current = true
        setLoginBusy(true)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let flow = null
        try {
          flow = await requestStartLogin(region, fetch, signal)
        } catch (error) {
          flow = normalizeLogin({ ok: false, status: 'error', region, error: error instanceof Error ? error.message : String(error) })
        }
        if (signal?.aborted === true) return
        setLogin(flow)
        if (flow.ok === true && flow.status === 'pending') {
          openAuthUrl(flow.authUrl)
          flow = await followLoginStatus(fetch, {
            signal,
            onUpdate: (next) => {
              if (signal?.aborted !== true) setLogin(next)
            },
          })
          if (signal?.aborted === true) return
          setLogin(flow)
          if (flow.status === 'complete') {
            setModelRevision((current) => current + 1)
            let nextStatus
            try {
              nextStatus = await requestStatus(fetch, signal)
            } catch {
              nextStatus = undefined
            }
            if (signal?.aborted === true) return
            if (nextStatus !== undefined) {
              setStatus(nextStatus)
              setLoadError('')
            }
            setNotice({ kind: 'success', text: '已添加账号；推理仍使用当前激活账号。' })
          }
        }
        setLoginBusy(false)
        actionInFlightRef.current = false
      }

      /**
       * 签到写操作（开关 / 手动）后重新读取 status：/status 只读本地状态，
       * 因此这里拿到的是调度器最新落盘的计数，不会额外触发上游请求。
       */
      const reloadAfterCheckin = async (signal, failureText) => {
        let nextStatus
        try {
          nextStatus = await requestStatus(fetch, signal)
        } catch {
          nextStatus = undefined
        }
        if (signal?.aborted === true) return
        if (nextStatus !== undefined) {
          setStatus(nextStatus)
          setModelRevision((current) => current + 1)
          setLoadError('')
        }
        setNotice(failureText === ''
          ? { kind: 'success', text: '签到设置已更新。' }
          : { kind: 'error', text: failureText })
      }

      const runCheckin = async (mode, run) => {
        if (actionInFlightRef.current) return
        actionInFlightRef.current = true
        setCheckinBusy(mode)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let failure = ''
        try {
          await run(signal)
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        await reloadAfterCheckin(signal, failure === '' ? '' : `${mode === 'manual' ? '签到失败' : '设置失败'}：${failure}`)
        setCheckinBusy('')
        actionInFlightRef.current = false
      }
      const runCheckinToggle = (enabled) => runCheckin('toggle', (signal) => requestCheckinSettings(enabled, fetch, signal))
      const runCheckinNow = () => runCheckin('manual', (signal) => requestCheckinNow(fetch, signal))

      const button = (action, label) => h(
        'button',
        {
          className: 'wb-settings__button',
          type: 'button',
          disabled: controlsDisabled,
          onClick: () => runAction(action),
        },
        busyAction === action ? `${label}中…` : label,
      )

      return h(
        'section',
        {
          className: 'wb-settings',
          // 在 hub 里时标题元素属于详情页（`wb-hub-detail-title`）；独立挂载时才是自己那个。
          // 悬空 aria-labelledby 会让读屏软件念不出标题，因此这里必须跟着分支走。
          'aria-labelledby': inHub ? 'wb-hub-detail-title' : 'workbuddy-settings-title',
          'aria-busy': isBusy || loading,
        },
        h('style', null, styles),
        // 在 hub 详情页里，页眉由详情页统一给出；这里再画一遍就会出现同名两行。
        inHub ? null : h(
          'header',
          { className: 'wb-settings__head' },
          h('h3', { className: 'wb-settings__title', id: 'workbuddy-settings-title' }, 'WorkBuddy'),
          h('p', { className: 'wb-settings__lede' }, '使用本机 CodeBuddy 登录态'),
        ),
        loadError === '' ? null : h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `状态读取失败：${loadError}`),
        status?.ok === false
          ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'status' }, `凭据状态不可用：${displayText(status.error)}`)
          : null,
        status === null && loading
          ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在读取 WorkBuddy 状态…')
          : null,
        status === null ? null : h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, '账号'),
            h(DataRows, { rows: [
              ['昵称', displayText(status.account.nickname)],
              ['账号 ID 后四位', displayText(status.account.uidTail)],
              ['手机号', displayText(status.account.phoneMasked)],
            ] }),
          ),
          h(AccountSwitcher, { accounts: status.accounts, onSwitch: runSwitch, switchingId }),
          h(LoginPanel, {
            login,
            region: loginRegion,
            onRegion: setLoginRegion,
            onStart: runLogin,
            busy: isBusy,
            enabled: status.accounts.enabled,
          }),
          // 签到依赖账号目录（服务缺席时路由降级），因此与多账号开关一起出现/消失。
          status.accounts.enabled
            ? h(CheckinPanel, { checkin: status.checkin, busy: checkinBusy, onToggle: runCheckinToggle, onRun: runCheckinNow })
            : null,
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, '令牌'),
            h(DataRows, { rows: [
              ['Access 到期', formatExpiry(status.token.accessExpiresAt, status.token.accessDaysLeft)],
              ['Refresh 到期', formatExpiry(status.token.refreshExpiresAt, status.token.refreshDaysLeft)],
              ['上次刷新', formatTime(status.token.lastRefreshTime)],
            ] }),
          ),
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, '状态'),
            h(DataRows, { rows: [
              ['凭据可解析', status.state.credentialReadable ? '是' : '否'],
              ['上游 UA 修复', status.state.userAgentFix ? '已生效' : '未生效'],
              ['上游域名', displayText(status.state.upstreamHost)],
            ] }),
            // 「读不到 + 下一步做什么」由 Host 给出。这是唯一会整段展示非固定文案的地方，
            // 因此先过 safeHint（夹带长字面即整条丢弃），再交给用户。
            status.state.credentialHint === ''
              ? null
              : h(
                  'p',
                  { className: 'wb-settings__alert wb-settings__alert--error wb-settings__risk', role: 'status' },
                  status.state.credentialEncrypted
                    ? `凭据已加密：${status.state.credentialHint}`
                    : status.state.credentialHint,
                ),
          ),
        ),
        status === null && loading ? null : h(ModelsPanel, { initialModels, accountRevision: modelRevision, externalBusy: isBusy }),
        status === null ? null : h(
          'div',
          { className: 'wb-settings__section' },
          h('h4', { className: 'wb-settings__section-title' }, '用量与配额'),
          h(Credits, { credits: status.credits }),
        ),
        h(
          'div',
          { className: 'wb-settings__section' },
          h('h4', { className: 'wb-settings__section-title' }, '动作'),
          h('div', { className: 'wb-settings__actions' },
            button('test', '测试连接'),
            button('refresh', '刷新凭证'),
            button('reload', '重新读取'),
          ),
          notice === null ? null : h(
            'p',
            {
              className: notice.kind === 'error'
                ? 'wb-settings__alert wb-settings__alert--error wb-settings__risk'
                : 'wb-settings__alert wb-settings__risk',
              role: notice.kind === 'error' ? 'alert' : 'status',
              'aria-live': 'polite',
            },
            notice.text,
          ),
          h('p', { className: 'wb-settings__muted wb-settings__risk' }, '刷新凭证会轮换 refresh token。此前实测旧 access token 仍有效，但上游行为可能变化，请勿将此视为对所有版本的保证。'),
          h(
            'p',
            { className: 'wb-settings__guide' },
            '除浏览器登录外，也可先打开 CodeBuddy，或在终端运行 ',
            h('code', { className: 'wb-settings__code' }, 'codebuddy'),
            ' 完成登录，然后点击“重新读取”。',
          ),
        ),
      )
    }

    /**
     * 智谱清言 Agent 的账号区。
     *
     * 与 WorkBuddy 的 LoginPanel 最大差别：这里**没有**「打开授权页」链接。
     * 宿主自己起一只带独立 profile 的 Chromium 让用户在里面登录，登完从那只
     * 浏览器的 cookie 里取令牌。因此客户端只能做三件事：开始 / 轮询 / 取消。
     *
     * 文案里要说清「会弹出一个浏览器窗口」，否则用户会一直等一个不会出现的授权链接。
     */
    function AgentmoreLoginPanel({ login, onStart, onCancel, busy, cancelling = false }) {
      const status = login?.status ?? 'idle'
      const running = status === 'running'
      // 游客态：窗口已开、上游已发游客令牌，但用户**还没**真正登录。
      // 这不是错误（窗口必须继续开着等他输验证码），所以文案要指向下一步动作，
      // 而不是像早期那样直接报「登录失败」并把窗口关掉。
      const guestPending = running && login?.guestPending === true
      return h('div', { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '登录智谱清言'),
        h('p', { className: 'wb-settings__muted' }, '点击后会在这台机器上打开一个独立浏览器窗口，请在里面登录 chatglm.cn；登录完成后窗口会自动关闭，凭据只保存在本机加密账号库里。'),
        h('div', { className: 'wb-settings__actions' },
          h('button', {
            type: 'button',
            className: 'wb-settings__button',
            disabled: busy || running,
            onClick: onStart,
          }, running ? '等待登录完成…' : '打开登录窗口'),
          running
            ? h('button', {
              type: 'button',
              className: 'wb-settings__button',
              'data-agentmore-cancel': 'true',
              // 不能用 `busy`：登录轮询期间 busy 恒为 true，取消按钮会全程不可点，
              // 而「开了窗口又想放弃」正是最需要它的时刻。只在本请求在飞时禁用。
              disabled: cancelling,
              onClick: onCancel,
            }, cancelling ? '取消中…' : '取消')
            : null),
        running ? h('p', { className: 'wb-settings__muted', role: 'status' }, '窗口已打开，等待你在浏览器里完成登录…') : null,
        guestPending
          ? h('p', { className: 'wb-settings__alert wb-settings__risk', role: 'status' },
            '当前仍是游客身份：请在已打开的窗口里点击「登录」，用手机号或微信完成登录。窗口会一直保留，登录成功后这里会自动切换为已登录。')
          : null,
        status === 'complete'
          ? h('p', { className: 'wb-settings__alert wb-settings__risk', role: 'status' },
            `已添加：${displayText(login.account.displayName)}（推理仍使用当前激活账号）`)
          : null,
        status === 'cancelled'
          ? h('p', { className: 'wb-settings__muted' }, '登录已取消，未添加任何账号。')
          : null,
        status === 'error'
          ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `登录失败：${displayText(login.error)}`)
          : null,
      )
    }

    /** 智谱清言 Agent 的账号列表与切换。空列表时整块不渲染。 */
    function AgentmoreAccounts({ accounts, busy, switchingId, removingId, onSwitch, onRemove }) {
      if (accounts.length === 0) return null
      return h('div', { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '智谱清言账号'),
        ...accounts.map((account) => h('div', {
          key: account.id,
          className: 'wb-settings__model-row',
          'data-agentmore-account': account.id,
        },
        h('span', { className: 'wb-settings__model-copy' },
          h('span', { className: 'wb-settings__model-name' }, account.active ? `${account.displayName}（当前）` : account.displayName),
          h('span', { className: 'wb-settings__model-meta' }, account.userId === '' ? account.id : `用户 ${account.userId}`)),
        h('span', { className: 'wb-settings__actions' },
          h('button', {
            type: 'button',
            className: 'wb-settings__button',
            'data-agentmore-switch': account.id,
            'aria-pressed': account.active,
            disabled: busy || account.active,
            onClick: () => onSwitch(account.id),
          }, switchingId === account.id ? '切换中…' : '使用'),
          h('button', {
            type: 'button',
            className: 'wb-settings__button',
            'data-agentmore-remove': account.id,
            disabled: busy,
            onClick: () => onRemove(account.id),
          }, removingId === account.id ? '移除中…' : '移除')))))
    }

    /** 智谱清言 Agent 的积分区：与 WorkBuddy 的 Credits 同形，但口径与文案不同。 */
    function AgentmoreCredits({ credits, loggedIn, onRefresh, busy }) {
      if (loggedIn !== true) {
        return h('p', { className: 'wb-settings__muted' }, '尚未登录；登录后可查看剩余积分。')
      }
      const remaining = credits.remaining === null
        ? '未取到'
        : formatNumber(credits.remaining)
      return h('div', { className: 'wb-settings__credits' },
        h('div', { className: 'wb-settings__balance', 'aria-label': `剩余 ${remaining}` },
          h('span', { className: 'wb-settings__diamond', 'aria-hidden': 'true' }, '◆'),
          h('strong', { className: 'wb-settings__remaining' }, remaining),
          h('span', { className: 'wb-settings__remaining-label' }, '剩余积分')),
        h('div', { className: 'wb-settings__actions' },
          h('button', {
            type: 'button',
            className: 'wb-settings__button',
            disabled: busy === true,
            onClick: onRefresh,
          }, busy === true ? '读取中…' : '刷新积分')),
        h('p', { className: 'wb-settings__muted wb-settings__credit-note' }, '按智谱清言服务端积分口径；每 60 秒最多读取一次。'))
    }

    /**
     * 智谱清言 Agent 的整块设置卡。
     *
     * 为什么独立成一个 section 而不是并入 WorkBuddy 那张卡：
     * 两个订阅点的**账号与模型选择互不相干**（换 agentmore 账号不该影响 workbuddy
     * 的模型偏好），并进一张卡会让「我现在改的是哪一边」变得不可回答。
     */
    function AgentmoreSection({ initialStatus = undefined, inHub = false } = {}) {
      const [status, setStatus] = useState(() => initialStatus === undefined ? null : normalizeAgentmoreStatus(initialStatus))
      const [accounts, setAccounts] = useState([])
      const [login, setLogin] = useState(null)
      const [modelRevision, setModelRevision] = useState(0)
      const [loading, setLoading] = useState(initialStatus === undefined)
      const [loadError, setLoadError] = useState('')
      const [loginBusy, setLoginBusy] = useState(false)
      const [cancelBusy, setCancelBusy] = useState(false)
      const [creditsBusy, setCreditsBusy] = useState(false)
      const [switchingId, setSwitchingId] = useState('')
      const [removingId, setRemovingId] = useState('')
      const [notice, setNotice] = useState(null)
      const mountedRef = useRef(false)
      const controllerRef = useRef(null)
      const busyRef = useRef(false)
      // 登录轮询的独占锁。与 `busyRef` 分开：轮询可能持续数分钟，
      // 若共用一把锁，「取消」/「刷新积分」在整段等待里都会被静默丢弃。
      const loginFlowRef = useRef(false)
      // 「本次登录尝试已被取消」的**粘性**标记：只在 `runLogin` 开头复位。
      // 不能在 `runCancel` 尾部清掉——轮询循环此刻可能正等在 `setTimeout` 里，
      // 等它醒来时标记已被清空，于是又续上一轮轮询，取消形同无效。
      const cancelledRef = useRef(false)
      const cancelBusyRef = useRef(false)

      /** 状态 + 账号列表一起刷：切换/移除后两者都可能变，分开请求会看到中间态。 */
      const reload = async (signal) => {
        const [nextStatus, nextAccounts] = await Promise.all([
          requestAgentmoreStatus(fetch, signal),
          requestAgentmoreAccounts(fetch, signal),
        ])
        if (signal?.aborted === true) return
        setStatus(nextStatus)
        setAccounts(nextAccounts.accounts)
        setModelRevision((current) => current + 1)
        setLoadError('')
      }

      useEffect(() => {
        mountedRef.current = true
        const controller = new AbortController()
        controllerRef.current = controller
        setLoading(true)
        reload(controller.signal).then(() => {
          if (mountedRef.current && !controller.signal.aborted) setLoading(false)
        }, (error) => {
          if (!mountedRef.current || controller.signal.aborted) return
          setLoadError(error instanceof Error ? error.message : String(error))
          setLoading(false)
        })
        return () => {
          mountedRef.current = false
          busyRef.current = false
          controller.abort()
          if (controllerRef.current === controller) controllerRef.current = null
        }
      }, [])

      const busy = loginBusy || creditsBusy || switchingId !== '' || removingId !== ''

      /**
       * 开始登录：POST 起流程 → 轮询直到离开 running。
       *
       * `running` 是本插件自己的状态名（WorkBuddy 那边叫 `pending`），
       * 两套状态机刻意不合并：混用一个字符串集会让「哪边在跑」不可分辨。
       */
      const runLogin = async () => {
        if (loginFlowRef.current) return
        loginFlowRef.current = true
        cancelledRef.current = false
        setLoginBusy(true)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let flow
        try {
          flow = await requestAgentmoreStartLogin(fetch, signal)
        } catch (error) {
          flow = normalizeAgentmoreLogin({ ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
        if (signal?.aborted === true) return
        setLogin(flow)
        // 只要流程在跑就轮询；宿主的浏览器窗口由它自己管，客户端不参与。
        for (let poll = 0; poll < AGENTMORE_MAX_POLLS && flow.status === 'running'; poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, AGENTMORE_POLL_INTERVAL_MS))
          if (signal?.aborted === true) return
          // 用户已点取消：不再请求，也不覆盖本地那个 cancelled 状态。
          if (cancelledRef.current) break
          try {
            flow = await requestAgentmoreLoginStatus(fetch, signal)
          } catch (error) {
            flow = normalizeAgentmoreLogin({ ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) })
          }
          if (signal?.aborted === true) return
          if (cancelledRef.current) break
          setLogin(flow)
        }
        if (signal?.aborted === true) return
        if (flow.status === 'complete') {
          try {
            await reload(signal)
          } catch {
            /* 登录已成功；列表刷新失败不该把成功报成失败，下次重开设置卡自会读到。 */
          }
          if (signal?.aborted === true) return
          setNotice({ kind: 'success', text: '已添加智谱清言账号；推理仍使用当前激活账号。' })
        }
        setLoginBusy(false)
        loginFlowRef.current = false
      }

      /**
       * 取消登录：立刻把本地状态切到 cancelled，再通知宿主。
       *
       * 顺序不能反——`runLogin` 的轮询循环每轮都会 `setLogin(flow)`，
       * 若先发请求再改状态，一次在飞的 `running` 响应会把「已取消」盖回去。
       * `cancelledRef` 是粘性的，`runLogin` 下一次唤醒就会看到并退出循环。
       */
      const runCancel = async () => {
        if (cancelBusyRef.current) return
        cancelBusyRef.current = true
        cancelledRef.current = true
        setCancelBusy(true)
        setLogin(normalizeAgentmoreLogin({ ok: true, status: 'cancelled' }))
        const signal = controllerRef.current?.signal
        try {
          const next = await requestAgentmoreCancelLogin(fetch, signal)
          if (signal?.aborted === true) return
          setLogin(next)
        } catch (error) {
          if (signal?.aborted === true) return
          setNotice({ kind: 'error', text: `取消失败：${error instanceof Error ? error.message : String(error)}` })
        }
        setCancelBusy(false)
        cancelBusyRef.current = false
      }

      const runCredits = async () => {
        if (busyRef.current) return
        busyRef.current = true
        setCreditsBusy(true)
        setNotice(null)
        const signal = controllerRef.current?.signal
        try {
          const next = await requestAgentmoreCredits(fetch, signal)
          if (signal?.aborted === true) return
          setStatus((current) => current === null ? current : {
            ...current,
            credits: { remaining: next.remaining, display: next.display },
          })
        } catch (error) {
          if (signal?.aborted === true) return
          setNotice({ kind: 'error', text: `积分读取失败：${error instanceof Error ? error.message : String(error)}` })
        }
        setCreditsBusy(false)
        busyRef.current = false
      }

      const runSwitch = async (id) => {
        if (busyRef.current) return
        busyRef.current = true
        setSwitchingId(id)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let failure = ''
        try {
          await requestAgentmoreActivate(id, fetch, signal)
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        if (signal?.aborted === true) return
        try {
          await reload(signal)
        } catch {
          /* 切换已发出；状态读取失败下次重开设置卡会补上。 */
        }
        if (signal?.aborted === true) return
        setNotice(failure === ''
          ? { kind: 'success', text: '已切换智谱清言账号；模型与积分将使用新账号。' }
          : { kind: 'error', text: `切换失败：${failure}` })
        setSwitchingId('')
        busyRef.current = false
      }

      const runRemove = async (id) => {
        if (busyRef.current) return
        busyRef.current = true
        setRemovingId(id)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let failure = ''
        try {
          await requestAgentmoreRemove(id, fetch, signal)
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        if (signal?.aborted === true) return
        try {
          await reload(signal)
        } catch {
          /* 同上。 */
        }
        if (signal?.aborted === true) return
        setNotice(failure === ''
          ? { kind: 'success', text: '账号已移除。' }
          : { kind: 'error', text: `移除失败：${failure}` })
        setRemovingId('')
        busyRef.current = false
      }

      const loggedIn = status?.loggedIn === true
      return h('section', {
        className: 'wb-settings',
        // 同上：在 hub 里标题元素属于详情页，独立挂载时才用自己那个。
        'aria-labelledby': inHub ? 'wb-hub-detail-title' : 'agentmore-settings-title',
        'aria-busy': busy || loading,
      },
      h('style', null, styles),
      inHub ? null : h('header', { className: 'wb-settings__head' },
        h('h3', { className: 'wb-settings__title', id: 'agentmore-settings-title' }, '智谱清言 Agent'),
        h('p', { className: 'wb-settings__lede' }, '独立订阅点 · 使用 chatglm.cn 账号')),
      loadError === '' ? null : h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `状态读取失败：${loadError}`),
      status?.ok === false
        ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'status' }, `订阅状态不可用：${displayText(status.error)}`)
        : null,
      status === null && loading
        ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在读取智谱清言状态…')
        : null,
      status === null ? null : h(React.Fragment, null,
        h('div', { className: 'wb-settings__section' },
          h('h4', { className: 'wb-settings__section-title' }, '账号'),
          h(DataRows, { rows: [
            ['状态', loggedIn ? '已登录' : '未登录'],
            ['显示名', loggedIn ? displayText(status.account.displayName) : '—'],
            ['用户 ID', loggedIn ? displayText(status.account.userId) : '—'],
          ] })),
        h(AgentmoreCredits, { credits: status.credits, loggedIn, onRefresh: runCredits, busy: creditsBusy }),
        h(AgentmoreAccounts, {
          accounts,
          busy,
          switchingId,
          removingId,
          onSwitch: runSwitch,
          onRemove: runRemove,
        }),
        h(AgentmoreLoginPanel, { login, onStart: runLogin, onCancel: runCancel, busy: loginBusy, cancelling: cancelBusy }),
        // 模型面板复用 WorkBuddy 那个组件，只把三处请求换成 agentmore 路由 ——
        // 两边返回的是同形扁平 DTO，因此不需要第二套解析或第二套 UI。
        h(ModelsPanel, {
          accountRevision: modelRevision,
          externalBusy: busy || loading,
          requestModels: requestAgentmoreModels,
          requestSaveModels: requestAgentmoreSaveModels,
          requestRefreshModels: requestAgentmoreRefreshModels,
          providerLabel: '智谱清言 Agent',
          titleId: 'agentmore-models-title',
        }),
        notice === null ? null : h('p', {
          className: `wb-settings__alert wb-settings__risk${notice.kind === 'error' ? ' wb-settings__alert--error' : ''}`,
          role: notice.kind === 'error' ? 'alert' : 'status',
          'aria-live': 'polite',
        }, notice.text)),
      )
    }

    return {
      name: 'dsh-workbuddy-auth',
      inject: ['slots'],
      apply(ctx) {
        // 只注册**一张**座位：两个订阅点共用它，由 SubscriptionHub 在卡内切换。
        // 这样设置页导航里本插件只占一行，也不会因多占槽位把别家插件挤后。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workbuddy',
          order: 46,
          label: () => '订阅服务',
        }, SubscriptionHub))
      },
      __test: { Section, SubscriptionHub, HUB_PROVIDERS, normalizeHubView, ModelsPanel, normalizeModels, requestModels, requestSaveModels, requestRefreshModels, styles, normalizeStatus, normalizeCheckin, normalizeLogin, requestStatus, requestAction, runActionAndReload, requestCredentialSources, requestActivateCredentialSource, requestStartLogin, requestLoginStatus, requestCheckinSettings, requestCheckinNow, followLoginStatus, openAuthUrl, AgentmoreSection, AgentmoreLoginPanel, AgentmoreAccounts, AgentmoreCredits, normalizeAgentmoreStatus, normalizeAgentmoreLogin, normalizeAgentmoreAccounts, requestAgentmoreStatus, requestAgentmoreStartLogin, requestAgentmoreLoginStatus, requestAgentmoreCancelLogin, requestAgentmoreAccounts, requestAgentmoreActivate, requestAgentmoreRemove, requestAgentmoreCredits, requestAgentmoreModels, requestAgentmoreSaveModels, requestAgentmoreRefreshModels, agentmoreRoutes: AGENTMORE_ROUTES, agentmoreLoginStatuses: AGENTMORE_LOGIN_STATUSES, displayRules: { domains: LOGIN_DISPLAY_DOMAINS, steps: LOGIN_DISPLAY_STEPS, errorNames: LOGIN_DISPLAY_ERROR_NAMES, codes: LOGIN_DISPLAY_CODES, reasons: LOGIN_DIAGNOSTIC_REASONS, fields: LOGIN_DIAGNOSTIC_FIELDS, httpStatusMin: LOGIN_DISPLAY_HTTP_MIN, httpStatusMax: LOGIN_DISPLAY_HTTP_MAX, traceLimit: LOGIN_TRACE_LIMIT } },
    }
  },
})
