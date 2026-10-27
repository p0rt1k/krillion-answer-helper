-- CreateTable
CREATE TABLE "prompt" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer" (
    "promptId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "answer_pkey" PRIMARY KEY ("promptId","text")
);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_text_key" ON "prompt"("text");

-- AddForeignKey
ALTER TABLE "answer" ADD CONSTRAINT "answer_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
