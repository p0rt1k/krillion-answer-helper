import axios, { AxiosError } from 'axios'

const client = axios.create({ baseURL: 'https://playdaily.org/api/krillion/' })

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function deal(recent: string[]) {
  return await client.post<{
    prompts: { id: string; text: string; cat: string }[]
    tickets: Record<string, string>
  }>('deal', {
    mode: 'classic',
    recent: recent
  })
}

export async function getAnswers(promptsId: string, ticket: string) {
  try {
    const data = await client.get<{ answers: [number, string][] }>(`answers?prompt=${promptsId}&ticket=${ticket}`)
    return data.data
  } catch (error) {
    console.log((error as AxiosError).response?.data)
    const { wait } = (error as AxiosError).response?.data as { wait: number }
    await delay(wait)
    return getAnswers(promptsId, ticket)
  }
}
