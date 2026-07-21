package com.eventticketing.admin.web.form;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

/**
 * Hall creation form. For a seated hall provide rows/columns and optional VIP/Premium row
 * ranges (everything else defaults to Regular). For a non-seated hall provide a capacity.
 */
@Data
public class HallForm {

    @NotBlank
    private String name;

    private String address;

    private boolean seated;

    // Seated layout
    private Integer numRows;
    private Integer numColumns;
    private Integer vipFromRow;
    private Integer vipToRow;
    private Integer premiumFromRow;
    private Integer premiumToRow;

    // Non-seated
    private Integer capacity;

    /** JSON array of the visually-arranged seats (keyed by row/column), applied after creation. */
    private String layoutJson;
}
