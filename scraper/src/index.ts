import { deal, getAnswers } from './api'
import { addAnswers, addPrompts, getAllPrompts } from './db'

async function dealOne() {
  const saved = await getAllPrompts()
  const dealRes = (await deal(saved.map((x) => x.id))).data
  console.log({ dealRes })
  await addPrompts(dealRes.prompts)
  for (const promptId in dealRes.tickets) {
    const ticket = dealRes.tickets[promptId]
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
    for (let pp = 0; pp < 3; pp++) {
      list.push(dealOne())
    }
    await Promise.all(list)
  }
}

dealMany()
