package com.eventticketing.admin.web.form;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

/** Hall creation form. A seated hall starts with one section; non-seated halls use capacity. */
@Data
public class HallForm {

    @NotBlank
    private String name;

    private String address;

    private boolean seated;

    // Seated layout
    private Integer numRows;
    private Integer numColumns;

    // Non-seated
    private Integer capacity;

    /** JSON array of the visually-arranged seats (keyed by row/column), applied after creation. */
    private String layoutJson;
}
