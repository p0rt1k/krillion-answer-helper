import { deal, getAnswers } from './api'
import { addAnswers, addPrompts, getAllPrompts } from './db'

let activePrompts: {
  id: string
  text: string
  cat: string
}[] = []

async function dealOne() {
  const saved = await getAllPrompts()
  const dealRes = (await deal(saved.map((x) => x.id))).data
  const prompts = dealRes.prompts.filter((a) => activePrompts.find((o) => o.id === a.id) == undefined)
  const { tickets } = dealRes
  activePrompts.push(...prompts)
  await addPrompts(prompts)
  for (const promptId in tickets) {
    if (prompts.find((p) => p.id === promptId) == undefined) {
      continue
    }
    const ticket = tickets[promptId]
    const answers = await getAnswers(promptId, ticket)
    console.log(promptId, answers.answers.length)
    await addAnswers(
      answers.answers.map(([value, text]) => ({
        value,
        text,
        promptId
      }))
    )
  }
}

async function dealMany() {
  for (let index = 0; index < 30; index++) {
    const list = []
    for (let pp = 0; pp < 5; pp++) {
      list.push(dealOne())
    }
    await Promise.all(list)
    activePrompts = []
  }
}

dealMany()
