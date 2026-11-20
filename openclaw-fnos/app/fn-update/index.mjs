import http from 'node:http'
import path from 'node:path'

function prepareLatest(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/prepare-latest', method: 'POST' }, res => {
      res.resume()
      res.on('error', reject)
      res.on('end', () => resolve(res.statusCode))
    })
    req.setTimeout(5000, () => req.destroy(new Error('无法连接框架。')))
    req.on('error', reject)
    req.end()
  })
}

export default {
  id: 'fn-update',
  register(api) {
    api.registerCommand({
      name: 'fn_update',
      description: '检查飞牛 OpenClaw 内核更新，并在控制台确认切换',
      requireAuth: true,
      requiredScopes: ['operator.write'],
      agentPromptGuidance: ['在飞牛上检查 OpenClaw 内核更新时，可使用 /fn_update。检查通过后由飞牛管理员在控制台确认切换。'],
      async handler() {
        if (!process.env.TRIM_PKGVAR) return { text: '此命令需要 FN-OPENCLAW 框架。' }
        try {
          const status = await prepareLatest(path.join(process.env.TRIM_PKGVAR, 'run', 'core-control.sock'))
          if (status === 202) return { text: '已开始检查正式版。请在飞牛控制台查看，兼容性检查通过后可确认切换。' }
          if (status === 200) return { text: '候选内核已通过检查，请在飞牛控制台确认切换。' }
          if (status === 409) return { text: '框架正在处理其他操作，请查看飞牛控制台。' }
        } catch {
          return { text: '无法联系 FN-OPENCLAW 框架，请打开飞牛控制台检查。' }
        }
        return { text: '框架未能开始检查，请查看飞牛控制台。' }
      },
    })
  },
}
