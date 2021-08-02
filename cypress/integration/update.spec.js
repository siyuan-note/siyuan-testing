describe('example to-do app', () => {
  before(() => {
    cy.visit('http://127.0.0.1:6806')
  })

  it("open help", () => {
    cy.get("#barMore").click()
    cy.get("#commonMenu").find(".b3-menu__item").last().click()
    cy.wait(5000)
  })

  it("fold heading", () => {
    cy.get('.protyle-breadcrumb__item[data-node-id="20200812220555-lj3enxa"]').click()

    cy.get('[data-node-id="20210428212840-8rqwn5o"]')
    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+uparrow}")
    cy.wait(1000)
    cy.get('[data-node-id="20210428212840-8rqwn5o"]').should("not.exist")

    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+uparrow}")
    cy.wait(1000)
    cy.get('[data-node-id="20210428212840-8rqwn5o"]').should("exist")
  })

  it("move fold heading", () => {
    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+uparrow}")
    cy.wait(1000)
    cy.get('[data-node-id="20210428212840-8rqwn5o"]').should("not.exist")

    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+shift+downarrow}")
    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+uparrow}")
    cy.wait(1000)
    cy.get('[data-node-id="20210428212840-8rqwn5o"]').should("exist")
  })

  it("update fold heading", () => {
    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+uparrow}")
    cy.wait(1000)
    cy.get('[data-node-id="20210428212840-8rqwn5o"]').should("not.exist")

    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("foo")
    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().type("{ctrl+uparrow}")
    cy.wait(1000)
    cy.get('[data-node-id="20210428212840-8rqwn5o"]').should("exist")

    cy.get('[data-node-id="20210428212840-859h45j"][data-type="NodeHeading"]').first().contains("foo")
  })
})
