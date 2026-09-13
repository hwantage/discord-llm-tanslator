// This channel carries only inference commands and model artifacts. No extension
// API, storage settings, API keys, or general-purpose fetch is exposed to it.
export function createRpc(port, handler, timeoutMs = 660_000) {
  let sequence = 0;
  const pending = new Map();
  port.onmessage = async ({ data }) => {
    if (data?.reply) {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
      else request.resolve(data.result);
      return;
    }
    if (typeof data?.id !== "string" || typeof data.method !== "string") return;
    try {
      const result = await handler(data.method, data.args || []);
      const transfer = result instanceof ArrayBuffer ? [result] : [];
      port.postMessage({ reply: true, id: data.id, result }, transfer);
    } catch (error) {
      port.postMessage({ reply: true, id: data.id, error: {
        name: error.name, message: error.message, code: error.code
      } });
    }
  };
  port.start();
  return {
    call(method, ...args) {
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("모델 실행 환경의 응답 시간이 초과되었습니다."));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ id, method, args });
      });
    },
    close() {
      port.close();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("모델 실행 환경이 종료되었습니다."));
      }
      pending.clear();
    }
  };
}
