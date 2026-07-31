import assert from "node:assert/strict";
import test from "node:test";

import {
  modifierGroupsFromItemDetails,
  resolveModifierSelections
} from "../src/modifier-resolution.js";

function mealBranch(name, suffix) {
  return {
    option_id: `cheese-${suffix}`,
    name,
    modifier_groups: [
      {
        group_id: `side-${suffix}`,
        name: "Side",
        min_selections: 1,
        max_selections: 1,
        options: [
          {
            option_id: `medium-fries-${suffix}`,
            name: "Medium Waffle Potato Fries"
          }
        ]
      },
      {
        group_id: `drink-${suffix}`,
        name: "Drink",
        min_selections: 1,
        max_selections: 1,
        options: [
          {
            option_id: `cookies-cream-${suffix}`,
            name: "Cookies & Cream Milk Shake"
          }
        ]
      },
      {
        group_id: `sauce-${suffix}`,
        name: "Dipping Sauces",
        min_selections: 0,
        max_selections: 3,
        options: [
          {
            option_id: "ranch-sauce",
            name: "Ranch"
          }
        ]
      },
      {
        group_id: `dressing-${suffix}`,
        name: "Dressings",
        min_selections: 0,
        max_selections: 2,
        options: [
          {
            option_id: "ranch-dressing",
            name: "Ranch Dressing"
          }
        ]
      }
    ]
  };
}

function chickFilAModifiers() {
  return [
    {
      group_id: "cheese",
      name: "Cheese",
      min_selections: 1,
      max_selections: 1,
      options: [
        mealBranch("Pepper Jack", "pepper"),
        mealBranch("Colby Jack", "colby"),
        mealBranch("American", "american"),
        mealBranch("No Cheese", "none")
      ]
    }
  ];
}

function flattenSelections(values, output = []) {
  for (const value of values || []) {
    output.push(value);
    flattenSelections(value.options, output);
  }
  return output;
}

function flattenModifierGroups(groups, output = []) {
  for (const group of groups || []) {
    output.push(group);
    for (const option of group.options || []) {
      flattenModifierGroups(option.modifier_groups, output);
    }
  }
  return output;
}

test("normalizes the full raw modifier tree through the shared contract parser", () => {
  const groups = modifierGroupsFromItemDetails({
    item: {
      item_id: "meal-1",
      extras: [
        {
          extra_id: "cheese",
          title: "Cheese",
          min_num_options: 1,
          max_num_options: 1,
          options: [
            {
              option_id: "pepper",
              name: "Pepper Jack",
              extras: [
                {
                  extra_id: "sauce",
                  title: "Sauce",
                  options: [{ option_id: "ranch", name: "Ranch" }]
                }
              ]
            }
          ]
        }
      ]
    }
  });

  assert.equal(groups[0].options[0].modifier_groups[0].options[0].option_id, "ranch");
});

test("resolves only the Pepper Jack branch and returns both Ranch paths", () => {
  const result = resolveModifierSelections(chickFilAModifiers(), {
    requestedOptions: [
      { name: "Pepper Jack" },
      { name: "Medium Waffle Potato Fries" },
      { name: "Cookies and Cream Milk Shake" },
      { name: "Ranch", quantity: 2 }
    ]
  });

  assert.match(result.problems.join(" "), /Ranch.*ambiguous/i);
  const selected = flattenSelections(result.selections);
  assert.deepEqual(
    selected.map((option) => option.name),
    [
      "Pepper Jack",
      "Medium Waffle Potato Fries",
      "Cookies & Cream Milk Shake"
    ]
  );
  assert.equal(selected.some((option) => option.name === "Colby Jack"), false);

  const candidates = flattenModifierGroups(result.modifier_groups);
  assert.deepEqual(
    candidates
      .filter((group) => /Sauces|Dressings/.test(group.name))
      .map((group) => group.name)
      .sort(),
    ["Dipping Sauces", "Dressings"]
  );
  assert.equal(result.modifier_groups[0].options[0].name, "Pepper Jack");
});

test("an option_id disambiguates repeated branch IDs and preserves quantity two", () => {
  const result = resolveModifierSelections(chickFilAModifiers(), {
    requestedOptions: [
      { name: "Pepper Jack" },
      { name: "Medium Waffle Potato Fries" },
      { name: "Cookies and Cream Milk Shake" },
      { name: "Ranch", option_id: "ranch-sauce", quantity: 2 }
    ]
  });

  assert.deepEqual(result.problems, []);
  const selected = flattenSelections(result.selections);
  const ranch = selected.find((option) => option.option_id === "ranch-sauce");
  assert.equal(ranch.quantity, 2);
  assert.equal(
    selected.some((option) => option.option_id === "ranch-dressing"),
    false
  );
  assert.equal(
    selected.some((option) => option.name === "Colby Jack"),
    false
  );
});

test("validates nested options against their immediate supplied parent", () => {
  const groups = [
    {
      group_id: "preparation",
      name: "Preparation",
      min_selections: 0,
      max_selections: 1,
      options: [
        {
          option_id: "spicy-broth",
          name: "Spicy Broth",
          modifier_groups: [
            {
              group_id: "heat",
              name: "Heat",
              min_selections: 0,
              max_selections: 1,
              options: [{ option_id: "extra-hot", name: "Extra Hot" }]
            }
          ]
        }
      ]
    }
  ];

  const invalid = resolveModifierSelections(groups, {
    nestedOptions: [{ option_id: "extra-hot", name: "Extra Hot" }]
  });
  assert.match(invalid.problems.join(" "), /supplied parent path/);
  assert.deepEqual(invalid.selections, []);

  const valid = resolveModifierSelections(groups, {
    nestedOptions: [
      {
        option_id: "spicy-broth",
        name: "Spicy Broth",
        options: [{ option_id: "extra-hot", name: "Extra Hot" }]
      }
    ]
  });
  assert.deepEqual(valid.problems, []);
  assert.equal(
    valid.selections[0].options[0].option_id,
    "extra-hot"
  );
});

test("a unique explicit leaf ID materializes its ancestor path", () => {
  const groups = [
    {
      group_id: "preparation",
      name: "Preparation",
      min_selections: 0,
      max_selections: 1,
      options: [
        {
          option_id: "spicy-broth",
          name: "Spicy Broth",
          modifier_groups: [
            {
              group_id: "heat",
              name: "Heat",
              min_selections: 0,
              max_selections: 1,
              options: [{ option_id: "extra-hot", name: "Extra Hot" }]
            }
          ]
        }
      ]
    }
  ];

  const result = resolveModifierSelections(groups, {
    requestedOptions: [
      { name: "Extra Hot", option_id: "extra-hot" }
    ]
  });

  assert.deepEqual(result.problems, []);
  assert.equal(result.selections[0].option_id, "spicy-broth");
  assert.equal(result.selections[0].options[0].option_id, "extra-hot");
});

test("validates option ID names and counts quantity against group maximum", () => {
  const groups = [
    {
      group_id: "sauces",
      name: "Sauces",
      min_selections: 0,
      max_selections: 1,
      options: [{ option_id: "ranch", name: "Ranch" }]
    }
  ];

  const wrongName = resolveModifierSelections(groups, {
    requestedOptions: [
      { name: "Honey Mustard", option_id: "ranch" }
    ]
  });
  assert.match(wrongName.problems.join(" "), /supplied name.*does not match/);
  assert.deepEqual(wrongName.selections, []);

  const tooMany = resolveModifierSelections(groups, {
    requestedOptions: [{ name: "Ranch", quantity: 2 }]
  });
  assert.match(tooMany.problems.join(" "), /quantity limit/);
  assert.deepEqual(tooMany.selections, []);
});

test("caps requested and nested modifier quantities at one hundred", () => {
  const groups = [
    {
      group_id: "sauces",
      name: "Sauces",
      min_selections: 0,
      options: [{ option_id: "ranch", name: "Ranch" }]
    }
  ];

  const requested = resolveModifierSelections(groups, {
    requestedOptions: [{ name: "Ranch", quantity: 101 }]
  });
  assert.match(requested.problems.join(" "), /integer from 1 to 100/);
  assert.deepEqual(requested.selections, []);

  const nested = resolveModifierSelections(groups, {
    nestedOptions: [
      { option_id: "ranch", name: "Ranch", quantity: 101 }
    ]
  });
  assert.match(nested.problems.join(" "), /integer from 1 to 100/);
  assert.deepEqual(nested.selections, []);
});

test("a qualified name disambiguates one option ID reused by sibling groups", () => {
  const groups = [
    {
      group_id: "sauce",
      name: "Sauce",
      min_selections: 0,
      max_selections: 2,
      options: [{ option_id: "shared-ranch", name: "Ranch" }]
    },
    {
      group_id: "dressing",
      name: "Dressing",
      min_selections: 0,
      max_selections: 2,
      options: [{ option_id: "shared-ranch", name: "Ranch" }]
    }
  ];

  const ambiguousName = resolveModifierSelections(groups, {
    requestedOptions: [{ name: "Ranch", quantity: 2 }]
  });
  assert.match(
    ambiguousName.problems.join(" "),
    /exact qualified name: "Sauce Ranch" or "Dressing Ranch"/
  );

  const ambiguousId = resolveModifierSelections(groups, {
    requestedOptions: [
      { name: "Ranch", option_id: "shared-ranch", quantity: 2 }
    ]
  });
  assert.match(
    ambiguousId.problems.join(" "),
    /exact qualified name: "Sauce Ranch" or "Dressing Ranch"/
  );
  assert.deepEqual(ambiguousId.selections, []);

  const resolved = resolveModifierSelections(groups, {
    requestedOptions: [
      {
        name: "Sauce Ranch",
        option_id: "shared-ranch",
        quantity: 2
      }
    ]
  });
  assert.deepEqual(resolved.problems, []);
  assert.deepEqual(resolved.selections, [
    {
      option_id: "shared-ranch",
      name: "Ranch",
      quantity: 2
    }
  ]);
});

test("bounds large ambiguity output and reports omitted candidate paths", () => {
  const groups = Array.from({ length: 40 }, (_, index) => ({
    group_id: `group-${index}`,
    name: `Sauces ${index}`,
    min_selections: 0,
    max_selections: 1,
    options: [{ option_id: `ranch-${index}`, name: "Ranch" }]
  }));

  const result = resolveModifierSelections(groups, {
    requestedOptions: [{ name: "Ranch" }]
  });
  const publicGroups = flattenModifierGroups(result.modifier_groups);
  const publicOptions = publicGroups.reduce(
    (count, group) => count + group.options.length,
    0
  );

  assert.match(result.problems.join(" "), /Ranch.*ambiguous/i);
  assert.match(result.problems.join(" "), /32 additional modifier candidate paths were omitted/);
  assert.ok(publicGroups.length <= 25);
  assert.ok(publicOptions <= 100);
});
