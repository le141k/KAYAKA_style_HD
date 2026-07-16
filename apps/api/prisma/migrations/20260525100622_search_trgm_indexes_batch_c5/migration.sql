-- CreateIndex
CREATE INDEX "KbArticle_title_idx" ON "KbArticle" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "KbArticle_contentsText_idx" ON "KbArticle" USING GIN ("contentsText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Organization_name_idx" ON "Organization" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Staff_firstName_idx" ON "Staff" USING GIN ("firstName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Staff_lastName_idx" ON "Staff" USING GIN ("lastName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_fullName_idx" ON "User" USING GIN ("fullName" gin_trgm_ops);
