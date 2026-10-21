import { useState } from "react";
import { validateDefinition, type Definition } from "../contracts/polls";

export function PollEditor({
  initial,
  disabled,
  onSave,
}: {
  initial: Definition;
  disabled: boolean;
  onSave(definition: Definition): void;
}) {
  const [definition, setDefinition] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  function question(
    index: number,
    update: Partial<Definition["questions"][number]>,
  ) {
    setDefinition((d) => ({
      ...d,
      questions: d.questions.map((q, i) =>
        i === index ? { ...q, ...update } : q,
      ),
    }));
  }
  function move<T>(items: T[], index: number, direction: number): T[] {
    const result = [...items];
    const other = index + direction;
    if (other >= 0 && other < result.length)
      [result[index], result[other]] = [result[other]!, result[index]!];
    return result;
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const problem = validateDefinition(definition);
        setError(problem);
        if (!problem) onSave(definition);
      }}
    >
      <fieldset disabled={disabled} className="editor">
        <label>
          Poll title
          <input
            name="title"
            required
            value={definition.title}
            onChange={(e) =>
              setDefinition((d) => ({ ...d, title: e.target.value }))
            }
          />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea
            name="description"
            rows={3}
            value={definition.description}
            onChange={(e) =>
              setDefinition((d) => ({ ...d, description: e.target.value }))
            }
          />
        </label>
        <p className="muted">
          Up to 8 questions, with 2–6 options each. Titles: 160 UTF-8 bytes.
          Options: 96 bytes. Description: 512 bytes.
        </p>
        {definition.questions.map((q, index) => (
          <section
            key={index}
            className="question-editor"
            aria-label={`Question ${index + 1}`}
          >
            <div className="section-heading">
              <h2>Question {index + 1}</h2>
              <div className="actions">
                <button
                  type="button"
                  className="small"
                  disabled={index === 0}
                  onClick={() =>
                    setDefinition((d) => ({
                      ...d,
                      questions: move(d.questions, index, -1),
                    }))
                  }
                >
                  Move up
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={index === definition.questions.length - 1}
                  onClick={() =>
                    setDefinition((d) => ({
                      ...d,
                      questions: move(d.questions, index, 1),
                    }))
                  }
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    setDefinition((d) => ({
                      ...d,
                      questions: d.questions.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove question
                </button>
              </div>
            </div>
            <label>
              Question text
              <input
                name={`question-${index}`}
                required
                value={q.title}
                onChange={(e) => question(index, { title: e.target.value })}
              />
            </label>
            {q.options.map((option, optionIndex) => (
              <div key={optionIndex} className="option-editor">
                <label htmlFor={`option-${index}-${optionIndex}`}>
                  Option {optionIndex + 1}
                </label>
                <div className="option-controls">
                  <input
                    id={`option-${index}-${optionIndex}`}
                    name={`option-${index}-${optionIndex}`}
                    required
                    value={option}
                    onChange={(e) =>
                      question(index, {
                        options: q.options.map((o, i) =>
                          i === optionIndex ? e.target.value : o,
                        ),
                      })
                    }
                  />
                  <div className="actions">
                    <button
                      type="button"
                      className="small"
                      aria-label={`Move option ${optionIndex + 1} up`}
                      disabled={optionIndex === 0}
                      onClick={() =>
                        question(index, {
                          options: move(q.options, optionIndex, -1),
                        })
                      }
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="small"
                      aria-label={`Move option ${optionIndex + 1} down`}
                      disabled={optionIndex === q.options.length - 1}
                      onClick={() =>
                        question(index, {
                          options: move(q.options, optionIndex, 1),
                        })
                      }
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="small"
                      aria-label={`Remove option ${optionIndex + 1}`}
                      disabled={q.options.length <= 2}
                      onClick={() =>
                        question(index, {
                          options: q.options.filter(
                            (_, i) => i !== optionIndex,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="small"
              disabled={q.options.length >= 6}
              onClick={() => question(index, { options: [...q.options, ""] })}
            >
              Add option
            </button>
          </section>
        ))}
        <div className="actions">
          <button
            type="button"
            disabled={definition.questions.length >= 8}
            onClick={() =>
              setDefinition((d) => ({
                ...d,
                questions: [...d.questions, { title: "", options: ["", ""] }],
              }))
            }
          >
            Add question
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <div className="actions">
          <button type="submit" className="primary">
            Save draft
          </button>
        </div>
      </fieldset>
    </form>
  );
}
