describe("SiYuan", () => {
  before(() => {
    cy.visit("http://127.0.0.1:6806");
    cy.wait(3000);
  });

  /**
   * 打开用户指南
   * 点击左上角 #barWorkspace → 点击 data-id="userGuide" 菜单项
   * 验证编辑器区域加载
   */
  it("open user guide", () => {
    cy.get("#barWorkspace").click();
    cy.wait(300);
    cy.get('[data-id="userGuide"]').click();
    cy.wait(4000);

    // 验证：编辑器内容和面包屑存在
    cy.get(".protyle-wysiwyg").should("exist");
    cy.get(".protyle-breadcrumb").should("exist");
  });

  /**
   * 新建文档并输入内容
   * Ctrl+N 新建 → 标题 → 编辑器内容
   */
  it("create doc and type", () => {
    cy.get("body").type("{ctrl+n}");
    cy.wait(1500);

    cy.get(".protyle-title__input").first().type("E2E Test Doc{enter}", { force: true });
    cy.wait(500);

    cy.get(".protyle-wysiwyg").last()
      .type("## Hello Heading{enter}", { force: true })
      .type("This is a test paragraph.{enter}", { force: true })
      .type("- list item 1{enter}", { force: true })
      .type("list item 2{enter}", { force: true });
    cy.wait(500);

    cy.get(".protyle-breadcrumb").should("be.visible");
  });

  /**
   * 搜索新建的文档
   * 等 3s → 打开搜索 → 输入文档标题 → 检查结果
   */
  it("search created doc", () => {
    cy.wait(3000);

    cy.get("#barSearch").click();
    cy.wait(1500);

    cy.get(".b3-dialog--open #searchInput", { timeout: 10000 })
      .should("be.visible")
      .clear()
      .type("E2E Test Doc");
    cy.wait(3000);

    cy.get(".b3-dialog--open .search__list").should("exist");
    cy.get(".b3-dialog--open .search__list .b3-list-item").should("have.length.at.least", 1);
    cy.get("body").type("{esc}");
    cy.wait(500);
  });

  /**
   * 标题折叠/展开
   * 在已有标题上测试 Ctrl+Up 折叠和展开
   */
  it("heading fold unfold", () => {
    cy.get("body").type("{ctrl+n}");
    cy.wait(1500);

    cy.get(".protyle-title__input").first().type("Fold E2E Test{enter}", { force: true });
    cy.wait(500);

    cy.get(".protyle-wysiwyg").last()
      .type("## Fold Me{enter}", { force: true })
      .type("sub content under heading{enter}", { force: true })
      .type("more sub content{enter}", { force: true });
    cy.wait(1000);

    // 用面包屑聚焦，然后通过 heading 元素操作
    cy.get(".protyle-breadcrumb__item").last().click();
    cy.wait(500);

    // 点击 heading 让其获得焦点
    cy.get('[data-type="NodeHeading"]').last().click();
    cy.wait(300);

    // 折叠
    cy.get("body").type("{ctrl+uparrow}");
    cy.wait(1000);

    // 展开
    cy.get("body").type("{ctrl+uparrow}");
    cy.wait(500);

    cy.get('[data-type="NodeHeading"]').should("exist");
  });

  /**
   * 切换侧边栏
   * 点击 #barDock 隐藏 → 再点击显示
   */
  it("toggle dock sidebar", () => {
    // 隐藏侧边栏
    cy.get("#barDock").click();
    cy.wait(500);
    cy.get(".dock").should("not.be.visible");

    // 显示侧边栏
    cy.get("#barDock").click();
    cy.wait(500);
    cy.get(".dock").should("be.visible");
  });

  /**
   * 撤销/重做
   * 输入内容 → Ctrl+Z 撤销 → Ctrl+Shift+Z 重做
   */
  it("undo and redo", () => {
    cy.get("body").type("{ctrl+n}");
    cy.wait(1500);

    cy.get(".protyle-title__input").first().type("Undo Test{enter}", { force: true });
    cy.wait(500);

    cy.get(".protyle-wysiwyg").last().type("This will be undone.{enter}", { force: true });
    cy.wait(500);

    // 撤销
    cy.get("body").type("{ctrl+z}");
    cy.wait(800);

    // 重做
    cy.get("body").type("{ctrl+shift+z}");
    cy.wait(500);

    cy.get(".protyle-wysiwyg").should("exist");
  });

  /**
   * 代码块
   * 输入 ``` 触发代码块渲染
   */
  it("code block", () => {
    cy.get("body").type("{ctrl+n}");
    cy.wait(1500);

    cy.get(".protyle-title__input").first().type("Code Block Test{enter}", { force: true });
    cy.wait(500);

    // 输入 ``` 触发代码块
    cy.get(".protyle-wysiwyg").last().type("```js{enter}", { force: true });
    cy.wait(800);
    cy.get(".protyle-wysiwyg").last().type("console.log('hello')", { force: true });
    cy.wait(500);

    cy.get('[data-type="NodeCodeBlock"], .code-block').should("exist");
  });

  /**
   * 切换主题
   * 点击 #barMode → 选择深色主题
   */
  it("toggle theme", () => {
    cy.get("#barMode").click();
    cy.wait(300);

    cy.get('[data-id="themeDark"]').click();
    cy.wait(500);

    cy.get(".b3-dialog--open").should("not.exist");
  });

  /**
   * 文档树导航
   * 点击文档树中的文档项进行导航
   */
  it("doc tree navigate", () => {
    // 点击文档树中第一个文档项
    cy.get('li.b3-list-item[data-type="navigation-file"]', { timeout: 10000 })
      .first()
      .click({ force: true });
    cy.wait(1500);

    cy.get(".protyle-wysiwyg").should("exist");
    cy.get(".protyle-breadcrumb").should("exist");
  });

  /**
   * 斜杠菜单
   * 输入 / 打开块类型菜单
   */
  it("slash menu", () => {
    cy.get("body").type("{ctrl+n}");
    cy.wait(1500);

    cy.get(".protyle-title__input").first().type("Slash Menu Test{enter}", { force: true });
    cy.wait(500);

    // 输入 / 触发斜杠菜单
    cy.get(".protyle-wysiwyg").last().type("/", { force: true });
    cy.wait(500);

    // 验证搜索过滤菜单出现
    cy.get(".b3-menu").should("exist");
    cy.get("body").type("{esc}");
    cy.wait(300);
  });
});
