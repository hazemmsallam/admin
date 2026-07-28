package com.eventticketing.admin.web.form;

import lombok.Data;

import java.util.ArrayList;
import java.util.List;

/** Pricing form with one editable price row per hall section. */
@Data
public class PricingForm {

    private List<SectionPriceRow> sections = new ArrayList<>();

    @Data
    public static class SectionPriceRow {
        private Long sectionId;
        private String name;
        private String bookingMode;
        private String currency;
        private java.math.BigDecimal price;
    }
}
